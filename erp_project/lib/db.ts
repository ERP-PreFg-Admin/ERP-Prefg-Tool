import mysql from "mysql2/promise";
import { DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME, DB_POOL_SIZE, NODE_ENV } from "@/lib/env";

const globalForPool = globalThis as unknown as { dbPool?: mysql.Pool };

export const pool =
  globalForPool.dbPool ??
  mysql.createPool({
    host:     DB_HOST,
    port:     DB_PORT,
    user:     DB_USER,
    password: DB_PASSWORD,
    database: DB_NAME,
    connectionLimit: DB_POOL_SIZE,
    waitForConnections: true,
    queueLimit: 0,
    ssl: { rejectUnauthorized: false },
    timezone: "+00:00",
    // Keep TCP connections alive so the DB server doesn't drop idle pool
    // connections after its wait_timeout, which causes ECONNRESET.
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
    connectTimeout: 10000,
  });

if (NODE_ENV !== "production") {
  globalForPool.dbPool = pool;
}

// Retry once on transient connection errors. The first call typically hits a dead
// pooled connection; the pool removes it and the retry gets a fresh one.
//
// ETIMEDOUT is included because it genuinely happens against RDS — an observed
// connect timeout between two successful queries used to surface as a hard 500 on
// whatever page the user was loading. Unlike the others it is a timeout rather
// than a closed socket, so an immediate retry is likely to time out too; hence
// the short delay before retrying.
const RETRYABLE = new Set([
  "ECONNRESET",
  "PROTOCOL_CONNECTION_LOST",
  "ETIMEDOUT",
  "EPIPE",
  "ER_LOCK_WAIT_TIMEOUT",
]);

const RETRY_DELAY_MS = 250;

export async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err: any) {
    if (err.fatal || RETRYABLE.has(err.code)) {
      if (err.code === "ETIMEDOUT" || err.code === "ER_LOCK_WAIT_TIMEOUT") {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      }
      return fn();
    }
    throw err;
  }
}

export async function query<T = Record<string, unknown>>(
  sql: string,
  params?: any[]
): Promise<T[]> {
  return withRetry(async () => {
    // pool.query uses client-side parameter interpolation (text protocol).
    // pool.execute (server-side prepared statements) rejects null params in
    // MariaDB when used with the `? IS NULL` pattern (ER_WRONG_ARGUMENTS).
    // All paginated queries pass null to short-circuit WHERE clauses, so
    // pool.query is required here. DML statements (INSERT/UPDATE/DELETE) keep
    // pool.execute via the separate execute() function below.
    const [rows] = await pool.query(sql, params);
    return rows as T[];
  });
}

export async function execute(
  sql: string,
  params?: any[]
): Promise<mysql.ResultSetHeader> {
  return withRetry(async () => {
    const [result] = await pool.execute(sql, params);
    return result as mysql.ResultSetHeader;
  });
}
