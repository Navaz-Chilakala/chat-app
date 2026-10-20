import { route, json, requireUser } from "@/lib/http";
import { readableWorkspaceIds } from "@/lib/auth/access";
import { query } from "@/lib/db";

export const GET = route(async (req) => {
  const user = await requireUser();
  const ws = await readableWorkspaceIds(user);
  const status = req.nextUrl.searchParams.get("status");
  const rows = await query(
    `SELECT j.id, j.kind, j.status, j.priority, j.stage, j.progress, j.attempts, j.max_attempts, j.error, j.byte_size, j.created_at, j.started_at, j.finished_at, j.result,
            j.document_version_id, v.original_filename, d.title, d.id AS document_id, s.name AS source_name
     FROM ingestion_jobs j LEFT JOIN document_versions v ON v.id = j.document_version_id LEFT JOIN documents d ON d.id = v.document_id
     LEFT JOIN document_sources s ON s.id = j.source_id
     WHERE j.workspace_id = ANY($1) AND ($2::text IS NULL OR j.status = $2)
     ORDER BY CASE j.status WHEN 'running' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END, j.created_at DESC LIMIT 200`,
    [ws, status],
  );
  const counts = await query("SELECT status, count(*)::int AS n FROM ingestion_jobs WHERE workspace_id = ANY($1) GROUP BY status", [ws]);
  return json({ jobs: rows, counts });
});
