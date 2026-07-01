import type Database from "better-sqlite3";
import type { AlertEngine } from "../alerting/alert-engine.js";
import {
  DUST_EPSILON,
  applyPartialFill,
  closeStockPosition,
  insertWashSale,
  markStockPositionTimeCheck,
  openStockPositions,
  updateStockPositionMarket,
  updateStockPositionStops
} from "../db/queries.js";
import type { StockPosition } from "../types.js";
import { logger } from "../utils/logger.js";
import { AlpacaClient } from "./alpaca-client.js";
import { OrderManager } from "./order-manager.js";

export class PositionMonitor {
  private readonly orderManager: OrderManager;
  /** Positions whose soft-stop was deferred because the market is closed — log once per session. */
  private readonly deferredSoftStops = new Set<number>();

  constructor(
    private readonly db: Database.Database,
    private readonly alertEngine?: AlertEngine,
    private readonly alpaca = new AlpacaClient()
  ) {
    this.orderManager = new OrderManager(db, alpaca);
  }

  async checkAll() {
    await this.orderManager.monitorOrders();
    const positions = openStockPositions(this.db);
    for (const position of positions) {
      await this.checkPosition(position);
    }
  }

  /**
   * Reconcile local open positions against Alpaca. Dust-sized local rows with
   * no Alpaca counterpart are auto-closed; material divergences are alerted
   * and logged, never auto-acted on.
   */
  async reconcile() {
    let alpacaPositions;
    try {
      alpacaPositions = await this.alpaca.getPositions();
    } catch (error) {
      logger.warn({ error }, "reconciliation skipped: Alpaca positions unavailable");
      return;
    }
    const alpacaByTicker = new Map(alpacaPositions.map((p) => [p.symbol.toUpperCase(), Number(p.qty)]));
    const local = openStockPositions(this.db);
    const divergences: string[] = [];

    const localByTicker = new Map<string, number>();
    for (const position of local) {
      const ticker = position.ticker.toUpperCase();
      localByTicker.set(ticker, (localByTicker.get(ticker) ?? 0) + position.quantity);
    }

    for (const position of local) {
      const ticker = position.ticker.toUpperCase();
      if (!alpacaByTicker.has(ticker)) {
        if (position.quantity <= DUST_EPSILON) {
          closeStockPosition(this.db, position.id, "reconcile_dust");
          logger.warn({ positionId: position.id, ticker, quantity: position.quantity }, "reconciliation auto-closed dust position absent at Alpaca");
        } else {
          divergences.push(`${ticker}: local position #${position.id} holds ${position.quantity} but Alpaca has no position`);
        }
      }
    }

    for (const [ticker, localQty] of localByTicker) {
      const alpacaQty = alpacaByTicker.get(ticker);
      if (alpacaQty !== undefined && Math.abs(alpacaQty - localQty) > Math.max(DUST_EPSILON, localQty * 0.001)) {
        divergences.push(`${ticker}: local qty ${localQty} vs Alpaca qty ${alpacaQty}`);
      }
    }

    for (const [ticker, alpacaQty] of alpacaByTicker) {
      if (!localByTicker.has(ticker)) {
        divergences.push(`${ticker}: Alpaca holds ${alpacaQty} with no local open position`);
      }
    }

    if (divergences.length > 0) {
      logger.error({ divergences }, "position reconciliation found divergences (not auto-acted)");
      await this.alertEngine
        ?.systemAlert({
          type: "reconciliation",
          severity: "high",
          title: `Position reconciliation: ${divergences.length} divergence(s)`,
          body: divergences.join("\n"),
          data: { divergences }
        })
        .catch((error) => logger.warn({ error }, "reconciliation alert failed"));
    } else {
      logger.info({ localTickers: localByTicker.size, alpacaTickers: alpacaByTicker.size }, "position reconciliation clean");
    }
  }

  private async checkPosition(position: StockPosition) {
    const alpacaPosition = await this.alpaca.getPosition(position.ticker);
    const currentPrice = alpacaPosition ? money(alpacaPosition.current_price) : position.currentPrice ?? position.avgEntryPrice;
    const pnlUsd = (currentPrice - position.avgEntryPrice) * position.quantity;
    const pnlRatio = position.avgEntryPrice > 0
      ? (currentPrice - position.avgEntryPrice) / position.avgEntryPrice
      : null;
    updateStockPositionMarket(this.db, position.id, { currentPrice, pnlUsd, pnlRatio });

    if (this.flashCrash(position, currentPrice)) {
      await this.handleFlashCrash(position, currentPrice);
      return;
    }

    if (await this.stopLossFilled(position)) return;

    if (await this.softStopTriggered(position, currentPrice)) return;

    // Single overlap guard: if a discretionary exit is reserved or a stop is already
    // resting, no per-sleeve discretionary action (trailing arm, take-profit, time stop)
    // should fire this tick. softStopTriggered already returned if its preconditions
    // matched; everything below is non-emergency.
    if ((position.pendingExitQty ?? 0) > 0) return;
    if (position.stopLossOrderId || position.trailingStopOrderId) return;

    if (await this.hasSenatorExit(position)) {
      await this.exit(position, "senator_exit");
      return;
    }

    if (position.sleeve === "senator") {
      if (pnlRatio !== null && pnlRatio >= 0.15 && !position.trailingStopActive) await this.activateTrailingStop(position, 8);
      const restingStop = Boolean(position.stopLossOrderId || position.trailingStopOrderId);
      if (restingStop) return; // belt-and-suspenders for activateTrailingStop side effect
      if (pnlRatio !== null && pnlRatio >= 0.25 && position.status === "open") {
        await this.sellHalf(position, "take_profit");
        return;
      }
      if (pnlRatio !== null && pnlRatio <= -0.15) {
        await this.exit(position, "time_stop");
        return;
      }
      if (pnlRatio !== null) await this.checkSenatorTimeStops(position, pnlRatio);
    } else {
      if (pnlRatio !== null && pnlRatio >= 0.2 && !position.trailingStopActive) await this.activateTrailingStop(position, 8);
      const restingStop = Boolean(position.stopLossOrderId || position.trailingStopOrderId);
      if (restingStop) return;
    }
  }

  private async hasSenatorExit(position: StockPosition) {
    if (position.sleeve !== "senator" || !position.senatorName) return false;
    const row = this.db
      .prepare(
        `SELECT count(*) AS count
         FROM trades t
         JOIN politicians p ON p.id = t.politician_id
         WHERE p.name = ?
           AND t.ticker = ?
           AND t.direction = 'sell'
           AND datetime(t.detected_at) > datetime(?)`
      )
      .get(position.senatorName, position.ticker, position.openedAt) as { count: number };
    return row.count > 0;
  }

  private async softStopTriggered(position: StockPosition, currentPrice: number) {
    if (!position.stopLossPrice || currentPrice > position.stopLossPrice) return false;
    if (position.stopLossOrderId || position.trailingStopOrderId) return false;
    if ((position.pendingExitQty ?? 0) > 0) return false;

    // Never fire a market exit outside regular hours: the order cannot fill,
    // gets EOD-cancelled, and the soft-stop re-fires — an all-night
    // cancel/resubmit churn loop. Defer to the next open instead.
    const clock = await this.safeGetClock();
    if (!clock?.is_open) {
      if (!this.deferredSoftStops.has(position.id)) {
        this.deferredSoftStops.add(position.id);
        logger.warn(
          { positionId: position.id, ticker: position.ticker, currentPrice, stopLossPrice: position.stopLossPrice },
          "soft-stop condition met but market is closed; deferring exit to next open"
        );
      }
      return true;
    }
    this.deferredSoftStops.delete(position.id);

    const reason = position.sleeve === "13f" ? "fund_exit" : "stop_loss";
    logger.warn(
      { positionId: position.id, ticker: position.ticker, currentPrice, stopLossPrice: position.stopLossPrice },
      "soft-stop: position has no Alpaca stop order; triggering exit at stop price",
    );
    await this.orderManager.submitMarketExit(position.id, position.ticker, position.quantity, reason, position.sleeve, true);
    const pnlUsd = (currentPrice - position.avgEntryPrice) * position.quantity;
    const pnlRatio = position.avgEntryPrice > 0
      ? (currentPrice - position.avgEntryPrice) / position.avgEntryPrice
      : null;
    try {
      await this.alert("stop_triggered", position, { exitReason: "soft_stop", pnlUsd, pnlRatio });
    } catch (error) {
      logger.warn(
        { error, positionId: position.id, ticker: position.ticker },
        "soft-stop alert failed; exit was already queued, continuing monitor loop"
      );
    }
    return true;
  }

  private async stopLossFilled(position: StockPosition) {
    const orderIds = Array.from(
      new Set([position.trailingStopOrderId, position.stopLossOrderId].filter((orderId): orderId is string => Boolean(orderId)))
    );
    if (orderIds.length === 0) return false;

    for (const orderId of orderIds) {
      const order = await this.alpaca.getOrder(orderId);

      if (order.status === "rejected" || order.status === "expired") {
        logger.warn({ orderId, status: order.status, ticker: position.ticker }, "stop order rejected/expired — resubmitting");
        if (orderId === position.trailingStopOrderId) {
          this.db.prepare("UPDATE stock_positions SET trailing_stop_active = 0, trailing_stop_order_id = NULL WHERE id = ?").run(position.id);
          position.trailingStopActive = false;
          position.trailingStopOrderId = null;
        } else {
          this.db.prepare("UPDATE stock_positions SET stop_loss_order_id = NULL WHERE id = ?").run(position.id);
          position.stopLossOrderId = null;
        }
        const newStop = await this.orderManager.resubmitStopLoss(position);
        if (newStop) {
          updateStockPositionStops(this.db, position.id, { stopLossOrderId: newStop });
          position.stopLossOrderId = newStop;
        } else {
          position.stopLossOrderId = null;
        }
        continue;
      }

      if (order.status !== "filled") continue;

      const filledPrice = money(order.filled_avg_price ?? undefined) || position.stopLossPrice || position.currentPrice || position.avgEntryPrice;
      const filledQty = money(order.filled_qty) || position.quantity;
      const pnlUsd = (filledPrice - position.avgEntryPrice) * filledQty;
      const pnlRatio = position.avgEntryPrice > 0 ? (filledPrice - position.avgEntryPrice) / position.avgEntryPrice : null;
      const exitReason = orderId === position.trailingStopOrderId ? "trailing_stop" : "stop_loss";
      const remainder = position.quantity - filledQty;
      if (remainder > DUST_EPSILON) {
        applyPartialFill(this.db, position.id, filledQty, pnlUsd, false);
        if (orderId === position.trailingStopOrderId) {
          this.db.prepare(
            "UPDATE stock_positions SET trailing_stop_active = 0, trailing_stop_order_id = NULL WHERE id = ?"
          ).run(position.id);
          position.trailingStopActive = false;
          position.trailingStopOrderId = null;
        } else {
          this.db.prepare(
            "UPDATE stock_positions SET stop_loss_order_id = NULL WHERE id = ?"
          ).run(position.id);
          position.stopLossOrderId = null;
        }
        // Stops are whole-share only, so a fractional tail (< 1 share) can
        // never be covered by a resubmitted stop. Flush it with a market
        // exit (day TIF via submitMarketExit) while the market is open.
        if (remainder < 1) {
          await this.flushFractionalTail(position, remainder, exitReason);
        }
      } else {
        closeStockPosition(this.db, position.id, exitReason, pnlUsd, filledQty);
      }
      this.trackWashSaleIfNeeded(position.ticker, pnlUsd, order.filled_at ?? new Date().toISOString());
      await this.alert("stop_triggered", position, { exitReason, pnlUsd, pnlRatio });
      return true;
    }

    return false;
  }

  private async flushFractionalTail(position: StockPosition, remainder: number, exitReason: string) {
    try {
      const clock = await this.safeGetClock();
      if (!clock?.is_open) {
        logger.info(
          { positionId: position.id, ticker: position.ticker, remainder },
          "fractional tail after stop fill; market closed, exit deferred to next open"
        );
        return;
      }
      await this.orderManager.submitMarketExit(position.id, position.ticker, remainder, exitReason, position.sleeve, true);
      logger.info({ positionId: position.id, ticker: position.ticker, remainder }, "fractional tail market exit submitted");
    } catch (error) {
      logger.warn({ error, positionId: position.id, ticker: position.ticker, remainder }, "fractional tail exit failed; will retry via soft-stop path");
    }
  }

  private async safeGetClock() {
    try {
      return await this.alpaca.getClock();
    } catch (error) {
      logger.warn({ error }, "Alpaca clock lookup failed");
      return null;
    }
  }

  private async activateTrailingStop(position: StockPosition, trailPercent: number) {
    if (position.stopLossOrderId) {
      try {
        await this.alpaca.cancelOrder(position.stopLossOrderId);
      } catch (error) {
        logger.warn({ error, positionId: position.id }, "failed to cancel stop loss before trailing stop activation");
        return;
      }
    }

    const wholeQty = Math.floor(position.quantity);
    if (wholeQty < 1) return;
    const order = await this.alpaca.submitOrder({
      symbol: position.ticker,
      qty: wholeQty.toString(),
      side: "sell",
      type: "trailing_stop",
      time_in_force: "gtc",
      trail_percent: trailPercent.toString(),
      client_order_id: `st-trail-${position.id}-${Date.now()}`
    });
    this.db.prepare(
      "UPDATE stock_positions SET trailing_stop_active = 1, trailing_stop_pct = ?, trailing_stop_order_id = ?, stop_loss_order_id = NULL WHERE id = ?"
    ).run(trailPercent, order.id, position.id);
    position.stopLossOrderId = null;
    position.trailingStopActive = true;
    position.trailingStopPct = trailPercent;
    position.trailingStopOrderId = order.id;
    await this.alert("trailing_activated", position, { trailPercent });
  }

  private async sellHalf(position: StockPosition, reason: "take_profit" | "time_stop") {
    const quantity = position.quantity / 2;
    const postFillAction = reason === "time_stop" ? "day60_half" : null;
    await this.orderManager.submitMarketExit(position.id, position.ticker, quantity, reason, position.sleeve, false, postFillAction);
    await this.alert(reason, position, { quantity });
  }

  private async checkSenatorTimeStops(position: StockPosition, pnlRatio: number) {
    const ageDays = Math.floor((Date.now() - new Date(position.openedAt).getTime()) / 86_400_000);
    if (ageDays >= 30 && !position.day30Checked && pnlRatio < -0.05) {
      markStockPositionTimeCheck(this.db, position.id, "day30_checked");
      await this.alert("time_stop", position, { action: "day30_flag", pnlRatio });
    }

    // Skip time-stop actions while any sell is already pending for this position.
    // Prevents day-60 half-sell and day-90 full-exit from queueing overlapping orders,
    // and prevents re-queueing the same half-exit before its fill flips day60_exited_half.
    if ((position.pendingExitQty ?? 0) > 0) return;

    if (ageDays >= 90 && !position.trailingStopActive) {
      await this.exit(position, "time_stop");
      return;
    }
    if (ageDays >= 60 && ageDays < 90 && !position.day60ExitedHalf && pnlRatio >= -0.05 && pnlRatio <= 0.05) {
      await this.sellHalf(position, "time_stop");
    }
  }

  private async exit(position: StockPosition, reason: "senator_exit" | "time_stop" | "fund_exit") {
    await this.orderManager.submitMarketExit(position.id, position.ticker, position.quantity, reason, position.sleeve, true);
    await this.alert(reason, position, { quantity: position.quantity });
  }

  private flashCrash(position: StockPosition, currentPrice: number) {
    if (!position.currentPrice || position.currentPrice <= 0) return false;
    return (position.currentPrice - currentPrice) / position.currentPrice > 0.1;
  }

  private async handleFlashCrash(position: StockPosition, currentPrice: number) {
    const widenedStop = currentPrice * 0.95;
    if (position.stopLossOrderId) {
      try {
        await this.alpaca.replaceOrder(position.stopLossOrderId, {
          stop_price: widenedStop.toFixed(2),
          limit_price: (widenedStop * 0.98).toFixed(2)
        });
        updateStockPositionStops(this.db, position.id, { stopLossPrice: widenedStop });
      } catch (error) {
        logger.warn(
          { error, positionId: position.id, stopLossOrderId: position.stopLossOrderId, widenedStop },
          "flash-crash: failed to widen Alpaca stop; DB unchanged"
        );
        return;
      }
    } else {
      updateStockPositionStops(this.db, position.id, { stopLossPrice: widenedStop });
    }
    await this.alert("stop_triggered", position, { action: "flash_crash_hold", widenedStop });
    logger.warn({ ticker: position.ticker, currentPrice, widenedStop }, "flash crash protection widened stop and skipped auto-sell");
  }

  private trackWashSaleIfNeeded(ticker: string, pnlUsd: number, fillTimestamp: string) {
    if (pnlUsd >= 0) return;
    const saleDate = fillTimestamp.slice(0, 10);
    const cooldown = new Date(`${saleDate}T00:00:00.000Z`);
    cooldown.setUTCDate(cooldown.getUTCDate() + 31);
    insertWashSale(this.db, ticker, saleDate, cooldown.toISOString().slice(0, 10), Math.abs(pnlUsd));
  }

  private async alert(type: string, position: StockPosition, data: Record<string, unknown>) {
    await this.alertEngine?.executionNotification({
      type,
      ticker: position.ticker,
      direction: "sell",
      size: position.quantity,
      price: position.currentPrice ?? position.avgEntryPrice,
      pnlUsd: typeof data.pnlUsd === "number" ? data.pnlUsd : position.pnlUsd ?? undefined,
      reason: type,
      data
    });
  }
}

function money(value: string | number | undefined) {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}
