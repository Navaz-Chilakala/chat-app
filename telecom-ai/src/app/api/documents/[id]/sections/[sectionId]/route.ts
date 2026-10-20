import { route, json, requireUser, HttpError } from "@/lib/http";
import { documentAccess } from "@/lib/auth/access";
import { queryOne } from "@/lib/db";

type Ctx = { params: Promise<{ id: string; sectionId: string }> };

/** First chunk of a section (used by the document viewer's section tree). */
export const GET = route<Ctx>(async (_req, { params }) => {
  const user = await requireUser();
  const { id, sectionId } = await params;
  if (!(await documentAccess(user, id))) throw new HttpError(404, "Document not found");
  const row = await queryOne<{ id: string }>(
    `SELECT c.id FROM document_chunks c JOIN document_sections s ON s.id = c.section_id
     WHERE c.document_id = $1 AND (c.section_id = $2 OR s.parent_id = $2) ORDER BY c.ord LIMIT 1`,
    [id, sectionId],
  );
  if (!row) throw new HttpError(404, "This section has no text of its own");
  return json({ chunkId: row.id });
});
