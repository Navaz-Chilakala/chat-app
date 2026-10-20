import { route, json, requireUser, HttpError } from "@/lib/http";
import { readableWorkspaceIds } from "@/lib/auth/access";
import { query, queryOne } from "@/lib/db";

type Ctx = { params: Promise<{ id: string }> };

export const GET = route<Ctx>(async (_req, { params }) => {
  const user = await requireUser();
  const { id } = await params;
  const job = await queryOne("SELECT * FROM ingestion_jobs WHERE id = $1 AND workspace_id = ANY($2)", [id, await readableWorkspaceIds(user)]);
  if (!job) throw new HttpError(404, "Job not found");
  const events = await query("SELECT id, ts, level, stage, message, data FROM ingestion_job_events WHERE job_id = $1 ORDER BY id LIMIT 500", [id]);
  return json({ job, events });
});
