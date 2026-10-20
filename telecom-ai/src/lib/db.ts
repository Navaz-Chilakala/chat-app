import pg from "pg";
import { attachDatabasePool } from "@vercel/functions";
import { env } from "./env";
import { logger } from "./logger";

// Return bigint/numeric as JS numbers where safe (counts, sums).
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));

declare global {
  // eslint-disable-next-line no-var
  var __telecomPool: pg.Pool | undefined;
}

const onVercel = !!process.env.VERCEL;

export function pool(): pg.Pool {
  if (!globalThis.__telecomPool) {
    const url = env().DATABASE_URL;
    const local = /localhost|127\.0\.0\.1/.test(url);
    const p = new pg.Pool({
      connectionString: url,
      max: onVercel ? Math.min(env().DB_POOL_MAX, 3) : env().DB_POOL_MAX,
      // Serverless instances are frozen between requests; short idle times avoid reusing sockets the
      // database (or Neon's pooler) has already closed.
      idleTimeoutMillis: onVercel ? 5_000 : 10_000,
      connectionTimeoutMillis: 10_000,
      keepAlive: true,
      // Never hang a request forever on a dead connection or a runaway query.
      query_timeout: 60_000,
      statement_timeout: 55_000,
      ssl: local || /sslmode=disable/.test(url) ? undefined : { rejectUnauthorized: false },
    });
    // Without a listener, an idle client closed by the server emits an unhandled 'error' and crashes the process.
    p.on("error", (err) => logger.warn("db.idle_client_error", { error: err.message }));
    // On Vercel (Fluid compute), release idle clients before the instance is suspended.
    if (onVercel) attachDatabasePool(p);
    globalThis.__telecomPool = p;
  }
  return globalThis.__telecomPool;
}

const TRANSIENT = /Connection terminated|ECONNRESET|EPIPE|connection timeout|Client has encountered a connection error|terminating connection/i;

export type Queryable = Pick<pg.PoolClient, "query">;

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  params: unknown[] = [],
  client?: Queryable,
): Promise<T[]> {
  if (client) return (await client.query<T>(sql, params)).rows;
  try {
    return (await pool().query<T>(sql, params)).rows;
  } catch (err) {
    // One retry on a dropped pooled connection (common after a serverless freeze or a database wake-up).
    if (!TRANSIENT.test((err as Error).message)) throw err;
    logger.warn("db.retry_after_connection_error", { error: (err as Error).message });
    return (await pool().query<T>(sql, params)).rows;
  }
}

export async function queryOne<T extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  params: unknown[] = [],
  client?: Queryable,
): Promise<T | null> {
  const rows = await query<T>(sql, params, client);
  return rows[0] ?? null;
}

export async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool() {
  if (globalThis.__telecomPool) {
    await globalThis.__telecomPool.end();
    globalThis.__telecomPool = undefined;
  }
}
