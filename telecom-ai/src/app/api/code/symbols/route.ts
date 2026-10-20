import { route, json, requireUser } from "@/lib/http";
import { readableWorkspaceIds } from "@/lib/auth/access";
import { query } from "@/lib/db";

export const GET = route(async (req) => {
  const user = await requireUser();
  const ws = await readableWorkspaceIds(user);
  const q = (req.nextUrl.searchParams.get("q") ?? "").trim();
  const symbols = await query(
    `SELECT s.id, s.name, s.kind, s.path, s.language, s.line_start, s.line_end, s.chunk_id, v.commit_sha, v.license, d.id AS document_id, src.name AS repo
     FROM code_symbols s JOIN document_versions v ON v.id = s.version_id JOIN documents d ON d.id = v.document_id
     LEFT JOIN document_sources src ON src.id = d.source_id
     WHERE d.workspace_id = ANY($1) AND v.is_current AND ($2 = '' OR s.name ILIKE '%' || $2 || '%' OR s.path ILIKE '%' || $2 || '%')
     ORDER BY (lower(s.name) = lower($2)) DESC, length(s.name), s.path LIMIT 200`,
    [ws, q],
  );
  const repos = await query(
    `SELECT src.id, src.name, src.url, src.license, src.status, (SELECT commit_sha FROM repository_snapshots r WHERE r.source_id = src.id ORDER BY created_at DESC LIMIT 1) AS commit_sha,
            (SELECT count(*)::int FROM documents d WHERE d.source_id = src.id) AS files
     FROM document_sources src WHERE src.kind = 'git_repo' AND src.workspace_id = ANY($1) ORDER BY src.name`,
    [ws],
  );
  return json({ symbols, repos });
});
