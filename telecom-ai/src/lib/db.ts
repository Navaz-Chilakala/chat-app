import pg from "pg";
import { env } from "./env";

// Return bigint/numeric as JS numbers where safe (counts, sums).
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));

declare global {
  // eslint-disable-next-line no-var
  var __telecomPool: pg.Pool | undefined;
}

export function pool(): pg.Pool {
  if (!globalThis.__telecomPool) {
    const url = env().DATABASE_URL;
    const local = /localhost|127\.0\.0\.1/.test(url);
    globalThis.__telecomPool = new pg.Pool({
      connectionString: url,
      max: env().DB_POOL_MAX,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
      ssl: local || /sslmode=disable/.test(url) ? undefined : { rejectUnauthorized: false },
    });
  }
  return globalThis.__telecomPool;
}

export type Queryable = Pick<pg.PoolClient, "query">;

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  params: unknown[] = [],
  client: Queryable = pool(),
): Promise<T[]> {
  const res = await client.query<T>(sql, params);
  return res.rows;
}

export async function queryOne<T extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  params: unknown[] = [],
  client: Queryable = pool(),
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
