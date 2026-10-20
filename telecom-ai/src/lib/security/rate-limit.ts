import { queryOne } from "../db";

/** Fixed-window counter in Postgres (works across serverless instances). Returns false when over limit. */
export async function rateLimit(key: string, max: number, windowSec: number): Promise<boolean> {
  const row = await queryOne<{ count: number }>(
    `INSERT INTO rate_limits(key, window_start, count)
     VALUES ($1, to_timestamp(floor(extract(epoch FROM now()) / $2) * $2), 1)
     ON CONFLICT (key, window_start) DO UPDATE SET count = rate_limits.count + 1
     RETURNING count`,
    [key, windowSec],
  );
  if (Math.random() < 0.01) await queryOne("DELETE FROM rate_limits WHERE window_start < now() - interval '1 day'");
  return (row?.count ?? 0) <= max;
}
