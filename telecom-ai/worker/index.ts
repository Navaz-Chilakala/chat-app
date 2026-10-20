/**
 * Background ingestion worker. Runs independently of the web app and the browser:
 *   npm run worker            # poll forever (container deployment)
 *   npm run worker -- --once  # drain the queue and exit (cron / CI)
 * Also enqueues scheduled source syncs whose interval has elapsed.
 */
import "../scripts/load-env";
import http from "node:http";
import os from "node:os";
import { drainQueue } from "../src/lib/ingest/runner";
import "../src/lib/ingest/handlers";
import { closePool, query, vacuum } from "../src/lib/db";
import { migrate } from "../src/lib/migrate";
import { ensureEmbeddingModel } from "../src/lib/embeddings";
import { terminateOcr } from "../src/lib/ingest/ocr";
import { enqueueStaleReindex } from "../src/lib/ingest/pipeline";
import { logger, errorMessage } from "../src/lib/logger";

const once = process.argv.includes("--once");
const pollMs = Number(process.env.WORKER_POLL_MS ?? 5000);
const workerId = `${os.hostname()}:${process.pid}`;
let stopping = false;
let lastBeat = Date.now();

async function scheduleDueSyncs() {
  const rows = await query<{ id: string }>(
    `INSERT INTO ingestion_jobs(workspace_id, kind, source_id, priority)
     SELECT s.workspace_id, 'sync_source', s.id, 4 FROM document_sources s
     WHERE s.status = 'active' AND s.sync_interval_hours IS NOT NULL
       AND (s.last_synced_at IS NULL OR s.last_synced_at < now() - make_interval(hours => s.sync_interval_hours))
       AND NOT EXISTS (SELECT 1 FROM ingestion_jobs j WHERE j.source_id = s.id AND j.kind = 'sync_source' AND j.status IN ('queued','running'))
     RETURNING id`,
  );
  if (rows.length) logger.info("worker.scheduled_syncs", { count: rows.length });
}

async function main() {
  if (process.env.AUTO_MIGRATE !== "false") await migrate();
  // Reclaim rows left by earlier re-indexes or failed jobs before indexing more (size-capped databases).
  await vacuum(["document_chunks", "document_sections", "embeddings", "embedding_cache"]);
  await ensureEmbeddingModel();
  logger.info("worker.start", { workerId, once });
  await enqueueStaleReindex();
  if (process.env.WORKER_HEALTH_PORT) {
    http
      .createServer((_, res) => {
        const healthy = Date.now() - lastBeat < Math.max(120_000, pollMs * 10) || stopping;
        res.writeHead(healthy ? 200 : 503, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: healthy, workerId, lastBeat: new Date(lastBeat).toISOString() }));
      })
      .listen(Number(process.env.WORKER_HEALTH_PORT));
  }
  do {
    try {
      if (process.env.WORKER_SCHEDULE_SYNCS !== "false") await scheduleDueSyncs();
      const n = await drainQueue({ workerId, maxJobs: once ? Infinity : 25 });
      lastBeat = Date.now();
      if (n) logger.info("worker.batch", { processed: n });
      if (once) break;
      if (!n) await new Promise((r) => setTimeout(r, pollMs));
    } catch (err) {
      logger.error("worker.loop_error", { error: errorMessage(err) });
      await new Promise((r) => setTimeout(r, pollMs * 2));
    }
  } while (!stopping);
  await terminateOcr();
  await closePool();
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    logger.info("worker.stopping", { signal: sig });
    stopping = true; // the current job finishes; its heartbeat stops otherwise and it is requeued
  });
}

main().catch((err) => {
  logger.error("worker.fatal", { error: errorMessage(err) });
  process.exit(1);
});
