/**
 * Activate and sync seeded sources by name, e.g. the 5G Core OpenAPI definitions:
 *   npm run sync:sources -- openapi            # official forge.3gpp.org repo, GitHub mirror as fallback
 *   npm run sync:sources -- "UERANSIM"         # any seeded source whose name contains the text
 * Index jobs are left queued for the worker (`npm run worker -- --once`).
 */
import "./load-env";
import { closePool, query, queryOne } from "../src/lib/db";
import { ensureCommonsWorkspace, seedSources } from "../src/lib/sources/registry";
import { drainQueue } from "../src/lib/ingest/runner";
import "../src/lib/ingest/handlers";

const wanted = process.argv.slice(2).join(" ").trim();
if (!wanted) throw new Error('Usage: npm run sync:sources -- <openapi | part of a source name>');
// "openapi": try the official repository first, the community mirror only if the official sync fails.
const candidates = wanted.toLowerCase() === "openapi" ? ["forge.3gpp.org", "GitHub mirror"] : [wanted];

const ws = await ensureCommonsWorkspace();
await seedSources(ws);
for (const name of candidates) {
  const src = await queryOne<{ id: string; name: string }>(
    "SELECT id, name FROM document_sources WHERE workspace_id = $1 AND kind <> '3gpp_archive' AND name ILIKE $2 ORDER BY created_at LIMIT 1",
    [ws, `%${name}%`],
  );
  if (!src) {
    console.log(`No seeded source matches "${name}"`);
    continue;
  }
  await query("UPDATE document_sources SET status = 'active' WHERE id = $1", [src.id]);
  const job = await queryOne<{ id: string }>("INSERT INTO ingestion_jobs(workspace_id, kind, source_id, priority, max_attempts) VALUES ($1,'sync_source',$2,1,1) RETURNING id", [ws, src.id]);
  console.log(`Syncing "${src.name}" (job ${job!.id})`);
  await drainQueue({ kinds: ["sync_source"], maxJobs: 1 });
  const run = await queryOne<{ status: string; stats: unknown; error: string | null }>("SELECT status, stats, error FROM source_sync_runs WHERE source_id = $1 ORDER BY started_at DESC LIMIT 1", [src.id]);
  console.log("Sync result:", JSON.stringify(run, null, 2));
  if (run?.status === "succeeded") break;
  // A failed official sync must not keep retrying on schedule while the fallback is in use.
  await query("UPDATE document_sources SET status = 'paused' WHERE id = $1", [src.id]);
}
const queued = await queryOne<{ n: number }>("SELECT count(*)::int AS n FROM ingestion_jobs WHERE kind = 'index_version' AND status = 'queued'");
console.log(`Index jobs queued: ${queued?.n ?? 0}`);
await closePool();
