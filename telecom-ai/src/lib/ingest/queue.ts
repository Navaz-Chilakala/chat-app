import type pg from "pg";
import { query, queryOne, type Queryable } from "../db";

export type JobKind = "index_version" | "fetch_url" | "sync_source" | "reembed" | "delete_document";

export interface JobRow {
  id: string;
  workspace_id: string;
  kind: JobKind;
  status: string;
  priority: number;
  payload: Record<string, unknown>;
  document_version_id: string | null;
  source_id: string | null;
  byte_size: number;
  attempts: number;
  max_attempts: number;
  created_by: string | null;
  cancel_requested: boolean;
}

export async function enqueueJob(
  job: {
    workspaceId: string;
    kind: JobKind;
    payload?: Record<string, unknown>;
    documentVersionId?: string | null;
    sourceId?: string | null;
    byteSize?: number;
    priority?: number;
    createdBy?: string | null;
    maxAttempts?: number;
  },
  client?: Queryable,
): Promise<{ id: string; existing: boolean }> {
  // Idempotent for index jobs: the partial unique index allows only one live job per version.
  const row = await queryOne<{ id: string }>(
    `INSERT INTO ingestion_jobs(workspace_id, kind, payload, document_version_id, source_id, byte_size, priority, created_by, max_attempts)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT DO NOTHING RETURNING id`,
    [job.workspaceId, job.kind, job.payload ?? {}, job.documentVersionId ?? null, job.sourceId ?? null, job.byteSize ?? 0, job.priority ?? 5, job.createdBy ?? null, job.maxAttempts ?? 3],
    client,
  );
  if (row) return { id: row.id, existing: false };
  const live = await queryOne<{ id: string }>(
    "SELECT id FROM ingestion_jobs WHERE document_version_id = $1 AND kind = 'index_version' AND status IN ('queued','running')",
    [job.documentVersionId ?? null],
    client,
  );
  return { id: live!.id, existing: true };
}

export interface ClaimOptions {
  workerId: string;
  maxBytes?: number;
  kinds?: JobKind[];
  /** Skip heavy documents (PDF/DOC/DOCX/zip, reference-only downloads) — used by the serverless cron processor. */
  lightOnly?: boolean;
}

export async function claimJob(opts: ClaimOptions): Promise<JobRow | null> {
  return queryOne<JobRow>(
    `UPDATE ingestion_jobs SET status = 'running', locked_by = $1, locked_at = now(), heartbeat_at = now(),
            started_at = COALESCE(started_at, now()), attempts = attempts + 1, error = NULL
     WHERE id = (
       SELECT id FROM ingestion_jobs
       WHERE status = 'queued' AND run_after <= now() AND NOT cancel_requested
         AND ($2::bigint IS NULL OR byte_size <= $2)
         AND ($3::text[] IS NULL OR kind = ANY($3))
         AND (NOT $4::boolean OR document_version_id IS NULL OR NOT EXISTS (
               SELECT 1 FROM document_versions v WHERE v.id = document_version_id
               AND (lower(coalesce(v.original_filename, '')) ~ '[.](pdf|docx?|zip)$' OR v.storage_key IS NULL)))
       ORDER BY priority, run_after
       FOR UPDATE SKIP LOCKED LIMIT 1)
     RETURNING *`,
    [opts.workerId, opts.maxBytes ?? null, opts.kinds ?? null, opts.lightOnly ?? false],
  );
}

export async function heartbeat(jobId: string, stage?: string, progress?: number): Promise<{ cancel: boolean }> {
  const row = await queryOne<{ cancel_requested: boolean }>(
    "UPDATE ingestion_jobs SET heartbeat_at = now(), stage = COALESCE($2, stage), progress = COALESCE($3, progress) WHERE id = $1 RETURNING cancel_requested",
    [jobId, stage ?? null, progress ?? null],
  );
  return { cancel: !!row?.cancel_requested };
}

export async function jobEvent(jobId: string, level: "debug" | "info" | "warn" | "error", stage: string | null, message: string, data?: unknown, client?: Queryable) {
  await query("INSERT INTO ingestion_job_events(job_id, level, stage, message, data) VALUES ($1,$2,$3,$4,$5)", [jobId, level, stage, message.slice(0, 2000), data ?? null], client);
}

export async function completeJob(jobId: string, result: Record<string, unknown>) {
  await query("UPDATE ingestion_jobs SET status = 'succeeded', finished_at = now(), progress = 1, stage = 'done', result = $2, locked_by = NULL WHERE id = $1", [jobId, result]);
}

/** Failed attempts are retried with exponential backoff until max_attempts, then marked failed. */
export async function failJob(job: Pick<JobRow, "id" | "attempts" | "max_attempts">, error: string, retryable = true) {
  const final = !retryable || job.attempts >= job.max_attempts;
  await query(
    `UPDATE ingestion_jobs SET status = $2, error = $3, locked_by = NULL,
       run_after = now() + ($4 || ' seconds')::interval, finished_at = CASE WHEN $2 = 'failed' THEN now() ELSE NULL END
     WHERE id = $1`,
    [job.id, final ? "failed" : "queued", error.slice(0, 4000), String(Math.min(3600, 30 * 2 ** job.attempts))],
  );
  return final;
}

export async function cancelJob(jobId: string) {
  await query(
    `UPDATE ingestion_jobs SET cancel_requested = true,
       status = CASE WHEN status = 'queued' THEN 'cancelled' ELSE status END,
       finished_at = CASE WHEN status = 'queued' THEN now() ELSE finished_at END
     WHERE id = $1 AND status IN ('queued','running')`,
    [jobId],
  );
}

/** Requeue jobs whose worker died (no heartbeat for `staleMinutes`). */
export async function recoverStaleJobs(staleMinutes = 15): Promise<number> {
  const rows = await query<{ id: string }>(
    `UPDATE ingestion_jobs SET status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END,
       error = 'Worker stopped responding (heartbeat timeout); ' || CASE WHEN attempts >= max_attempts THEN 'giving up' ELSE 'requeued' END,
       locked_by = NULL, finished_at = CASE WHEN attempts >= max_attempts THEN now() ELSE NULL END
     WHERE status = 'running' AND heartbeat_at < now() - ($1 || ' minutes')::interval RETURNING id`,
    [String(staleMinutes)],
  );
  return rows.length;
}

export type { pg };
