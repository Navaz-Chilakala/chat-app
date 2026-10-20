import { route, json, requireUser, HttpError } from "@/lib/http";
import { query, queryOne } from "@/lib/db";

type Ctx = { params: Promise<{ id: string }> };

/** Citation viewer: the chunk, its clause siblings and provenance. Access enforced via workspace membership. */
export const GET = route<Ctx>(async (_req, { params }) => {
  const user = await requireUser();
  const { id } = await params;
  const chunk = await queryOne<Record<string, unknown>>(
    `SELECT c.id, c.document_id, c.version_id, c.section_id, c.ord, c.chunk_type, c.content, c.clause, c.heading_path, c.page_start, c.page_end,
            c.symbol, c.language, c.line_start, c.line_end, c.identifiers, c.flags, c.spec_number, c.release, c.source_type, c.authority_tier, c.metadata,
            d.title, d.spec_type, d.review_status, v.version_label, v.source_url, v.commit_sha, v.repo_path, v.license, v.is_current, v.published_at
     FROM document_chunks c JOIN documents d ON d.id = c.document_id JOIN document_versions v ON v.id = c.version_id
     JOIN workspace_memberships m ON m.workspace_id = c.workspace_id AND m.user_id = $2
     WHERE c.id = $1`,
    [id, user.id],
  );
  if (!chunk) throw new HttpError(404, "Source not found or not accessible");
  const siblings = chunk.section_id
    ? await query("SELECT id, ord, chunk_type, content, page_start, page_end FROM document_chunks WHERE version_id = $1 AND section_id = $2 ORDER BY ord LIMIT 60", [chunk.version_id, chunk.section_id])
    : await query("SELECT id, ord, chunk_type, content, page_start, page_end FROM document_chunks WHERE version_id = $1 AND ord BETWEEN $2 - 2 AND $2 + 2 ORDER BY ord", [chunk.version_id, chunk.ord]);
  return json({ chunk, siblings });
});
