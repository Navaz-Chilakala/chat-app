import { route, json, requireUser, HttpError } from "@/lib/http";
import { userWorkspaces, hasRole } from "@/lib/auth/access";
import { query, queryOne } from "@/lib/db";

type Ctx = { params: Promise<{ id: string }> };

/** Safe retry: the pipeline clears partial output for the version before re-indexing (idempotent). */
export const POST = route<Ctx>(async (_req, { params }) => {
  const user = await requireUser();
  const { id } = await params;
  const job = await queryOne<{ workspace_id: string; status: string; created_by: string | null }>("SELECT workspace_id, status, created_by FROM ingestion_jobs WHERE id = $1", [id]);
  if (!job) throw new HttpError(404, "Job not found");
  const ws = (await userWorkspaces(user.id)).find((w) => w.id === job.workspace_id);
  if (!ws || (!user.isAdmin && !hasRole(ws.role, "editor") && job.created_by !== user.id)) throw new HttpError(403, "Not allowed to retry this job");
  if (!["failed", "cancelled"].includes(job.status)) throw new HttpError(409, `Only failed or cancelled jobs can be retried (job is ${job.status})`);
  await query("UPDATE ingestion_jobs SET status = 'queued', attempts = 0, error = NULL, cancel_requested = false, run_after = now(), finished_at = NULL, progress = 0, stage = NULL WHERE id = $1", [id]);
  await query("UPDATE document_versions v SET status = 'pending' FROM ingestion_jobs j WHERE j.id = $1 AND v.id = j.document_version_id AND v.status = 'failed'", [id]);
  await query("INSERT INTO ingestion_job_events(job_id, level, stage, message) VALUES ($1,'info','retry',$2)", [id, `Retry requested by ${user.email}`]);
  return json({ ok: true });
});
