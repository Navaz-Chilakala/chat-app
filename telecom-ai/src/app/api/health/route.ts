import { json } from "@/lib/http";
import { envStatus } from "@/lib/env";
import { queryOne } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Liveness + dependency check. Reports configuration problems without exposing secret values. */
export async function GET() {
  const envCheck = envStatus();
  const out: Record<string, unknown> = { ok: false, env: envCheck.ok ? "ok" : envCheck.problems.map((p) => p.split(":")[0]) };
  if (!envCheck.ok) return json(out, { status: 503 });
  try {
    const db = await queryOne<{ vector: string | null; migrated: number }>(
      `SELECT (SELECT extversion FROM pg_extension WHERE extname = 'vector') AS vector,
              (SELECT count(*)::int FROM information_schema.tables WHERE table_name = 'schema_migrations') AS migrated`,
    );
    out.database = "ok";
    out.pgvector = db?.vector ?? "missing";
    out.migrated = db?.migrated === 1;
    if (db?.migrated === 1) {
      out.queue = await queryOne(
        "SELECT count(*) FILTER (WHERE status='queued')::int AS queued, count(*) FILTER (WHERE status='running')::int AS running, count(*) FILTER (WHERE status='failed')::int AS failed FROM ingestion_jobs",
      );
    }
    out.ok = db?.vector != null && db?.migrated === 1;
  } catch {
    out.database = "unreachable";
  }
  return json(out, { status: out.ok ? 200 : 503 });
}
