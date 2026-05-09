import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  DISCORD_WEBHOOK_URL: z.string().optional().default(""),
  DISCORD_BOT_TOKEN: z.string().optional().default(""),
  QUIVER_API_KEY: z.string().optional().default(""),
  UNUSUAL_WHALES_API_KEY: z.string().optional().default(""),
  CONGRESS_GOV_API_KEY: z.string().optional().default(""),
  SEC_USER_AGENT: z.string().min(5).default("StockTracker mokhtari.digix@gmail.com"),
  YAHOO_FINANCE_ENABLED: z
    .string()
    .default("true")
    .transform((value) => value === "true"),
  DB_PATH: z.string().default("./data/stocktracker.db"),
  API_PORT: z.coerce.number().int().positive().default(3001),
  API_HOST: z.string().default("127.0.0.1"),
  API_AUTH_TOKEN: z.string().min(1),
  LOG_LEVEL: z.string().default("info"),
  POLL_EDGAR: z.coerce.number().int().positive().default(300000),
  POLL_QUIVER: z.coerce.number().int().positive().default(900000),
  POLL_SENATE_EFD: z.coerce.number().int().positive().default(1800000),
  POLL_HOUSE_CLERK: z.coerce.number().int().positive().default(3600000),
  ALPACA_KEY_ID: z.string().optional().default(""),
  ALPACA_SECRET_KEY: z.string().optional().default(""),
  ALPACA_PAPER: z
    .string()
    .default("true")
    .transform((value) => value === "true"),
  EXECUTION_ENABLED: z
    .string()
    .default("false")
    .transform((value) => value === "true"),
  EXECUTION_MODE: z.enum(["paper", "live"]).default("paper"),
  MAX_DAILY_TRADES: z.coerce.number().int().positive().default(5)
});

export const config = envSchema.parse(process.env);
