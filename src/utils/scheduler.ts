import cron from "node-cron";
import { logger } from "./logger.js";

const inFlight = new Set<string>();

export function scheduleEvery(name: string, intervalMs: number, job: () => Promise<void>): NodeJS.Timeout {
  void runJob(name, job);
  return setInterval(() => void runJob(name, job), intervalMs);
}

export function scheduleCron(name: string, expression: string, job: () => Promise<void>) {
  return cron.schedule(expression, () => void runJob(name, job));
}

async function runJob(name: string, job: () => Promise<void>) {
  if (inFlight.has(name)) {
    logger.warn({ job: name }, "job tick skipped; previous run still in flight");
    return;
  }
  inFlight.add(name);
  try {
    logger.info({ job: name }, "job started");
    await job();
    logger.info({ job: name }, "job finished");
  } catch (error) {
    logger.error({ job: name, err: error instanceof Error ? error : new Error(String(error)) }, "job failed");
  } finally {
    inFlight.delete(name);
  }
}
