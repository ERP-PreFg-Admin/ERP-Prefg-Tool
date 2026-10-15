import winston from "winston";
import DailyRotateFile from "winston-daily-rotate-file";
import chalk from "chalk";
import { stampLogFields } from "./observability/log-context";

// ── level colors ───────────────────────────────────────────────────────────

const LEVEL_COLOR: Record<string, (s: string) => string> = {
  error: (s) => chalk.red(s),
  warn:  (s) => chalk.yellow(s),
  info:  (s) => chalk.cyan(s),
  debug: (s) => chalk.dim(s),
};

// ── fields excluded from extras line ──────────────────────────────────────

const SKIP = new Set(["service", "stack", "splat", "pid"]);

// ── pretty format (console only) ──────────────────────────────────────────

interface PrettyLogInfo {
  timestamp?: string | number
  level: string
  message: unknown
  requestId?: unknown
  module?: unknown
  deltaMs?: number
  stack?: string
  [key: string]: unknown
}

const prettyFormat = winston.format.printf(({ timestamp, level, message, requestId, module, code, deltaMs, stack, ...meta
}: PrettyLogInfo) => {
  const ts    = new Date(timestamp ?? Date.now()).toISOString().substring(11, 23);
  const req   = requestId ? String(requestId).substring(0, 8) : "--------";
  const delta = deltaMs != null ? `+${deltaMs}ms`.padEnd(8) : " ".repeat(8);
  const mod   = `[${String(code ?? module ?? "APP")}]`.padEnd(18);
  const lvl   = level.toUpperCase().padEnd(5);
  const color = LEVEL_COLOR[level] ?? ((s: string) => s);

  const extras = Object.entries(meta)
    .filter(([k, v]) => !SKIP.has(k) && v !== null && v !== undefined)
    .map(([k, v]) => `${chalk.dim(k + "=")}${JSON.stringify(v)}`)
    .join("  ");

  const header = [
    chalk.dim(ts),
    chalk.dim(delta),
    color(lvl),
    chalk.dim(`[req:${req}]`),
    chalk.magenta(mod),
    message,
  ].join("  ");

  const lines = [header];
  if (extras) lines.push(`  ${chalk.dim("│")}  ${extras}`);
  if (stack)  lines.push(`  ${chalk.dim(stack)}`);
  return lines.join("\n");
});

// ── format per transport ───────────────────────────────────────────────────

const consoleFormat = winston.format.combine(
  winston.format.timestamp(),
  prettyFormat,
);

// Files stay as JSON — no ANSI codes, easy to grep / ingest into log tools
const fileFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.json(),
);

// ── logger ─────────────────────────────────────────────────────────────────

// Serverless platforms (Vercel, Amplify Hosting compute, etc.) run on a
// read-only filesystem -- DailyRotateFile's mkdir('logs/') crashes the whole
// process on import. Those platforms already capture stdout/stderr in their
// own log viewers, so file transports are only useful for a real persistent
// server (VERCEL and AWS_LAMBDA_FUNCTION_NAME are set by their respective
// platforms; this covers self-hosted/VM deployments too).
const isServerless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME)

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  transports: [
    new winston.transports.Console({
      format: consoleFormat,
    }),

    ...(isServerless ? [] : [
      new DailyRotateFile({
        format: fileFormat,
        filename: "logs/app-%DATE%.log",
        datePattern: "YYYY-MM-DD",
        maxFiles: "14d",
        maxSize: "20m",
      }),

      new DailyRotateFile({
        level: "error",
        format: fileFormat,
        filename: "logs/error-%DATE%.log",
        datePattern: "YYYY-MM-DD",
        maxFiles: "30d",
      }),
    ]),
  ],
});

// Stamped at call time, not in a format: a format runs when the stream drains, which under
// backpressure can be inside another request's context.
const write = logger.write.bind(logger);
logger.write = ((info: object, ...rest: unknown[]) =>
  (write as (...a: unknown[]) => boolean)(stampLogFields(info), ...rest)) as typeof logger.write;

export default logger;