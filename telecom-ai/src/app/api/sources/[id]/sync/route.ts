import { route, json, requireAdmin, HttpError } from "@/lib/http";
import { queryOne } from "@/lib/db";
import { enqueueJob } from "@/lib/ingest/queue";

type Ctx = { params: Promise<{ id: string }> };

export const POST = route<Ctx>(async (_req, { params }) => {
  const admin = await requireAdmin();
  const { id } = await params;
  const s = await queryOne<{ workspace_id: string; status: string }>("SELECT workspace_id, status FROM document_sources WHERE id = $1", [id]);
  if (!s) throw new HttpError(404, "Source not found");
  if (s.status !== "active") throw new HttpError(409, `Source is ${s.status}; activate it first`);
  const live = await queryOne<{ id: string }>("SELECT id FROM ingestion_jobs WHERE source_id = $1 AND kind = 'sync_source' AND status IN ('queued','running')", [id]);
  if (live) return json({ jobId: live.id, existing: true });
  const job = await enqueueJob({ workspaceId: s.workspace_id, kind: "sync_source", sourceId: id, priority: 4, createdBy: admin.id, maxAttempts: 2 });
  return json({ jobId: job.id, existing: false });
});
