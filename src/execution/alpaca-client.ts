import { config } from "../config.js";
import { RateLimiter } from "../utils/rate-limiter.js";
import { logger } from "../utils/logger.js";

export interface AlpacaAccount {
  id: string;
  status: string;
  buying_power: string;
  cash: string;
  equity: string;
  portfolio_value: string;
  trading_blocked: boolean;
  account_blocked: boolean;
  multiplier?: string;
}

export interface OrderParams {
  symbol: string;
  qty?: number | string;
  notional?: number | string;
  side: "buy" | "sell";
  type: "market" | "limit" | "stop" | "stop_limit" | "trailing_stop";
  time_in_force: "day" | "gtc" | "opg" | "cls" | "ioc" | "fok";
  limit_price?: number | string;
  stop_price?: number | string;
  trail_percent?: number | string;
  order_class?: "simple" | "bracket" | "oco" | "oto";
  take_profit?: { limit_price: number | string };
  stop_loss?: { stop_price: number | string; limit_price?: number | string };
  client_order_id?: string;
  extended_hours?: boolean;
}

export interface AlpacaOrder {
  id: string;
  client_order_id: string;
  created_at: string;
  updated_at?: string;
  submitted_at?: string;
  filled_at?: string;
  expired_at?: string;
  canceled_at?: string;
  symbol: string;
  asset_id?: string;
  qty?: string;
  filled_qty: string;
  notional?: string;
  filled_avg_price?: string | null;
  order_class?: string;
  order_type?: string;
  type: string;
  side: "buy" | "sell";
  time_in_force: string;
  limit_price?: string | null;
  stop_price?: string | null;
  status: string;
}

export interface AlpacaPosition {
  asset_id: string;
  symbol: string;
  qty: string;
  avg_entry_price: string;
  market_value: string;
  cost_basis: string;
  unrealized_pl: string;
  unrealized_plpc: string;
  current_price: string;
  side: "long" | "short";
}

export interface AlpacaAsset {
  id: string;
  class: string;
  exchange: string;
  symbol: string;
  name: string;
  status: string;
  tradable: boolean;
  marginable: boolean;
  shortable: boolean;
  easy_to_borrow: boolean;
  fractionable: boolean;
}

export interface AlpacaClock {
  timestamp: string;
  is_open: boolean;
  next_open: string;
  next_close: string;
}

export interface AlpacaCalendarDay {
  date: string;
  open: string;
  close: string;
  session_open?: string;
  session_close?: string;
}

export class AlpacaClient {
  private readonly limiter = new RateLimiter(4);
  private readonly baseUrl =
    config.EXECUTION_MODE === "live" && !config.ALPACA_PAPER ? "https://api.alpaca.markets" : "https://paper-api.alpaca.markets";

  async getAccount(): Promise<AlpacaAccount> {
    return this.request<AlpacaAccount>("/v2/account");
  }

  async submitOrder(params: OrderParams): Promise<AlpacaOrder> {
    if (config.EXECUTION_MODE === "paper") await this.paperDelay();
    const order = await this.request<AlpacaOrder>("/v2/orders", { method: "POST", body: params });
    return config.EXECUTION_MODE === "paper" ? this.applyPaperSlippage(order) : order;
  }

  async cancelOrder(orderId: string): Promise<void> {
    await this.request<void>(`/v2/orders/${encodeURIComponent(orderId)}`, { method: "DELETE" });
  }

  async getOrder(orderId: string): Promise<AlpacaOrder> {
    const order = await this.request<AlpacaOrder>(`/v2/orders/${encodeURIComponent(orderId)}`);
    return config.EXECUTION_MODE === "paper" ? this.applyPaperSlippage(order) : order;
  }

  async listOrders(params: { status?: "open" | "closed" | "all"; symbols?: string[]; limit?: number } = {}): Promise<AlpacaOrder[]> {
    const search = new URLSearchParams();
    if (params.status) search.set("status", params.status);
    if (params.symbols?.length) search.set("symbols", params.symbols.join(","));
    if (params.limit) search.set("limit", String(params.limit));
    const suffix = search.toString() ? `?${search}` : "";
    const orders = await this.request<AlpacaOrder[]>(`/v2/orders${suffix}`);
    return config.EXECUTION_MODE === "paper" ? orders.map((order) => this.applyPaperSlippage(order)) : orders;
  }

  async replaceOrder(orderId: string, params: Partial<OrderParams>): Promise<AlpacaOrder> {
    const order = await this.request<AlpacaOrder>(`/v2/orders/${encodeURIComponent(orderId)}`, { method: "PATCH", body: params });
    return config.EXECUTION_MODE === "paper" ? this.applyPaperSlippage(order) : order;
  }

  async getPositions(): Promise<AlpacaPosition[]> {
    return this.request<AlpacaPosition[]>("/v2/positions");
  }

  async getPosition(symbol: string): Promise<AlpacaPosition | null> {
    try {
      return await this.request<AlpacaPosition>(`/v2/positions/${encodeURIComponent(symbol.toUpperCase())}`);
    } catch (error) {
      if (error instanceof AlpacaError && error.status === 404) return null;
      throw error;
    }
  }

  async closePosition(symbol: string, qty?: number): Promise<AlpacaOrder> {
    const search = new URLSearchParams();
    if (qty !== undefined) search.set("qty", String(qty));
    const suffix = search.toString() ? `?${search}` : "";
    return this.request<AlpacaOrder>(`/v2/positions/${encodeURIComponent(symbol.toUpperCase())}${suffix}`, { method: "DELETE" });
  }

  async getAsset(symbol: string): Promise<AlpacaAsset | null> {
    try {
      return await this.request<AlpacaAsset>(`/v2/assets/${encodeURIComponent(symbol.toUpperCase())}`);
    } catch (error) {
      if (error instanceof AlpacaError && error.status === 404) return null;
      throw error;
    }
  }

  async getClock(): Promise<AlpacaClock> {
    return this.request<AlpacaClock>("/v2/clock");
  }

  async getCalendar(start: string, end: string): Promise<AlpacaCalendarDay[]> {
    const search = new URLSearchParams({ start, end });
    return this.request<AlpacaCalendarDay[]>(`/v2/calendar?${search}`);
  }

  private async request<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
    if (!config.ALPACA_KEY_ID || !config.ALPACA_SECRET_KEY) {
      throw new AlpacaError(0, "Alpaca credentials are not configured");
    }

    return this.limiter.schedule(async () => {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: options.method ?? "GET",
        headers: {
          "APCA-API-KEY-ID": config.ALPACA_KEY_ID,
          "APCA-API-SECRET-KEY": config.ALPACA_SECRET_KEY,
          "Content-Type": "application/json",
          "User-Agent": "stock-tracker/1.0"
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body)
      });

      if (response.status === 204) return undefined as T;

      const text = await response.text();
      const payload = text.length > 0 ? safeJson(text) : null;
      if (!response.ok) {
        const message = typeof payload?.message === "string" ? payload.message : text || response.statusText;
        logger.warn({ status: response.status, path, message }, "Alpaca request failed");
        throw new AlpacaError(response.status, message);
      }
      return payload as T;
    });
  }

  private async paperDelay() {
    const delayMs = 1000 + Math.floor(Math.random() * 4000);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  private applyPaperSlippage(order: AlpacaOrder): AlpacaOrder {
    if (!order.filled_avg_price) return order;
    const price = Number(order.filled_avg_price);
    if (!Number.isFinite(price) || price <= 0) return order;
    const direction = order.side === "buy" ? 1 : -1;
    // Deterministic per order id: repeated getOrder reads must not re-randomize
    // the fill price, or P&L becomes non-reproducible across polls.
    const randomization = 0.5 + hash01(order.id);
    return { ...order, filled_avg_price: (price * (1 + direction * 0.001 * randomization)).toFixed(4) };
  }
}

/** FNV-1a hash of a string mapped to [0, 1). */
function hash01(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) / 0x100000000;
}

export class AlpacaError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

function safeJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}
