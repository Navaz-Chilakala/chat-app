/**
 * Register and index official 3GPP specifications (latest version per spec) from the 3GPP archive.
 *   npm run sync:3gpp                         # all configured series (21–38)
 *   npm run sync:3gpp -- --priority           # only the ~35 priority specs from the platform brief
 *   npm run sync:3gpp -- --specs 23.501,23.502 --series 23
 *   npm run sync:3gpp -- --no-index           # register versions only; the worker indexes them later
 * Requires outbound HTTPS access to www.3gpp.org.
 */
import "./load-env";
import { closePool, query, queryOne } from "../src/lib/db";
import { ensureCommonsWorkspace, seedSources } from "../src/lib/sources/registry";
import { PRIORITY_SPECS } from "../src/lib/sources/threegpp";
import { drainQueue } from "../src/lib/ingest/runner";
import { terminateOcr } from "../src/lib/ingest/ocr";
import { enqueueStaleReindex } from "../src/lib/ingest/pipeline";
import "../src/lib/ingest/handlers";

const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const ws = await ensureCommonsWorkspace();
await seedSources(ws);
const src = await queryOne<{ id: string; config: Record<string, unknown> }>("SELECT id, config FROM document_sources WHERE kind = '3gpp_archive' AND workspace_id = $1 LIMIT 1", [ws]);
if (!src) throw new Error("3GPP archive source missing");
const specs = args.includes("--priority") ? [...PRIORITY_SPECS] : arg("specs")?.split(",").map((s) => s.trim());
const series = arg("series")?.split(",") ?? (specs ? [...new Set(specs.map((s) => s.slice(0, 2)))] : undefined);
const config = { ...src.config, ...(specs ? { specs } : { specs: undefined }), ...(series ? { series } : {}), ...(arg("limit") ? { limit: Number(arg("limit")) } : {}) };
await query("UPDATE document_sources SET status = 'active', config = $2 WHERE id = $1", [src.id, JSON.stringify(config)]);
const job = await queryOne<{ id: string }>("INSERT INTO ingestion_jobs(workspace_id, kind, source_id, priority, max_attempts) VALUES ($1,'sync_source',$2,1,2) RETURNING id", [ws, src.id]);
console.log(`Sync job ${job!.id} for series ${JSON.stringify(config.series)}${specs ? `, ${specs.length} spec(s)` : ""}`);
await drainQueue({ kinds: ["sync_source"], maxJobs: 1 });
const run = await queryOne<{ status: string; stats: unknown; error: string | null }>("SELECT status, stats, error FROM source_sync_runs WHERE source_id = $1 ORDER BY started_at DESC LIMIT 1", [src.id]);
console.log("Sync result:", JSON.stringify(run, null, 2));
const events = await query<{ level: string; message: string }>("SELECT level, message FROM ingestion_job_events WHERE job_id = $1 AND level IN ('warn','error') ORDER BY id LIMIT 30", [job!.id]);
for (const e of events) console.log(`[${e.level}] ${e.message}`);
const reindexed = await enqueueStaleReindex();
if (reindexed) console.log(`Re-index jobs queued for ${reindexed} version(s) built by an older chunker`);
const queued = await queryOne<{ n: number }>("SELECT count(*)::int AS n FROM ingestion_jobs WHERE kind = 'index_version' AND status = 'queued'");
console.log(`Index jobs queued: ${queued?.n ?? 0}`);
if (!args.includes("--no-index")) console.log(`Indexed ${await drainQueue({ kinds: ["index_version"] })} document version(s)`);
await terminateOcr();
await closePool();
