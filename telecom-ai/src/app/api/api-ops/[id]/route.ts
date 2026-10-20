import { route, json, requireUser, HttpError } from "@/lib/http";
import { query, queryOne } from "@/lib/db";

type Ctx = { params: Promise<{ id: string }> };

export const GET = route<Ctx>(async (_req, { params }) => {
  const user = await requireUser();
  const { id } = await params;
  const op = await queryOne<Record<string, unknown>>(
    `SELECT o.*, d.title AS document_title, d.id AS document_id, v.version_label, c.identifiers
     FROM api_operations o JOIN document_versions v ON v.id = o.version_id JOIN documents d ON d.id = v.document_id
     JOIN workspace_memberships m ON m.workspace_id = d.workspace_id AND m.user_id = $2 LEFT JOIN document_chunks c ON c.id = o.chunk_id
     WHERE o.id = $1`,
    [id, user.id],
  );
  if (!op) throw new HttpError(404, "Operation not found");
  // Referenced component schemas (one level) so the UI can show request/response models.
  const refs = [...new Set([...JSON.stringify([op.request_body, op.responses, op.parameters]).matchAll(/#\/components\/schemas\/([A-Za-z0-9_.-]+)/g)].map((m) => m[1]!))];
  const schemas = refs.length ? await query("SELECT name, schema, required FROM api_schemas WHERE version_id = $1 AND name = ANY($2)", [op.version_id, refs]) : [];
  return json({ operation: op, schemas });
});
