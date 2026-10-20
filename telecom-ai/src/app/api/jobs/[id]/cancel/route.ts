import { route, json, requireUser, HttpError } from "@/lib/http";
import { userWorkspaces, hasRole } from "@/lib/auth/access";
import { queryOne } from "@/lib/db";
import { cancelJob } from "@/lib/ingest/queue";

type Ctx = { params: Promise<{ id: string }> };

export const POST = route<Ctx>(async (_req, { params }) => {
  const user = await requireUser();
  const { id } = await params;
  const job = await queryOne<{ workspace_id: string; created_by: string | null }>("SELECT workspace_id, created_by FROM ingestion_jobs WHERE id = $1", [id]);
  if (!job) throw new HttpError(404, "Job not found");
  const ws = (await userWorkspaces(user.id)).find((w) => w.id === job.workspace_id);
  if (!ws || (!user.isAdmin && !hasRole(ws.role, "editor") && job.created_by !== user.id)) throw new HttpError(403, "Not allowed to cancel this job");
  await cancelJob(id);
  return json({ ok: true });
});
