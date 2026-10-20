import os from "node:os";
import { claimJob, completeJob, failJob, jobEvent, recoverStaleJobs, type JobKind, type JobRow } from "./queue";
import { CancelledError, PermanentError, indexVersion, markVersionFailed } from "./pipeline";
import { query } from "../db";
import { errorMessage, logger } from "../logger";
import { UnsafeUrlError } from "../security/ssrf";

export type JobHandler = (job: JobRow) => Promise<Record<string, unknown>>;

const handlers: Partial<Record<JobKind, JobHandler>> = {
  index_version: indexVersion,
};

/** Register additional handlers (URL fetch, source sync, re-embed) without import cycles. */
export function registerJobHandler(kind: JobKind, handler: JobHandler) {
  handlers[kind] = handler;
}

export async function runJob(job: JobRow): Promise<void> {
  const started = Date.now();
  await jobEvent(job.id, "info", "start", `Attempt ${job.attempts}/${job.max_attempts} on ${os.hostname()}`);
  try {
    const handler = handlers[job.kind];
    if (!handler) throw new PermanentError(`No handler for job kind ${job.kind}`);
    const result = await handler(job);
    await completeJob(job.id, { ...result, durationMs: Date.now() - started });
    await jobEvent(job.id, "info", "done", `Completed in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  } catch (err) {
    const msg = errorMessage(err);
    if (err instanceof CancelledError) {
      await query("UPDATE ingestion_jobs SET status = 'cancelled', finished_at = now(), error = $2 WHERE id = $1", [job.id, msg]);
      await markVersionFailed(job.document_version_id, "cancelled");
      await jobEvent(job.id, "warn", "cancelled", msg);
      return;
    }
    const permanent = err instanceof PermanentError || err instanceof UnsafeUrlError;
    const final = await failJob(job, msg, !permanent);
    await jobEvent(job.id, "error", "failed", final ? `Failed permanently: ${msg}` : `Attempt failed, will retry: ${msg}`);
    if (final) await markVersionFailed(job.document_version_id, msg);
    logger.error("job.failed", { jobId: job.id, kind: job.kind, final, error: msg });
  }
}

export interface WorkLoopOptions {
  workerId?: string;
  maxBytes?: number;
  kinds?: JobKind[];
  lightOnly?: boolean;
  /** Stop after this many ms (serverless cron); undefined = run until no work (CLI) */
  budgetMs?: number;
  maxJobs?: number;
}

/** Process queued jobs until the queue is empty, the time budget is spent, or maxJobs is reached. */
export async function drainQueue(opts: WorkLoopOptions = {}): Promise<number> {
  const workerId = opts.workerId ?? `${os.hostname()}:${process.pid}`;
  const deadline = opts.budgetMs ? Date.now() + opts.budgetMs : Infinity;
  await recoverStaleJobs();
  let n = 0;
  while (Date.now() < deadline && n < (opts.maxJobs ?? Infinity)) {
    const job = await claimJob({ workerId, maxBytes: opts.maxBytes, kinds: opts.kinds, lightOnly: opts.lightOnly });
    if (!job) break;
    await runJob(job);
    n++;
  }
  return n;
}
