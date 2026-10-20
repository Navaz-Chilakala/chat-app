import { route, json, requireUser, HttpError } from "@/lib/http";
import { query, queryOne } from "@/lib/db";

type Ctx = { params: Promise<{ id: string }> };

export const GET = route<Ctx>(async (_req, { params }) => {
  const user = await requireUser();
  const { id } = await params;
  const conv = await queryOne("SELECT id, title FROM conversations WHERE id = $1 AND user_id = $2", [id, user.id]);
  if (!conv) throw new HttpError(404, "Conversation not found");
  const messages = await query("SELECT id, role, content, answer, filters, created_at FROM messages WHERE conversation_id = $1 ORDER BY created_at", [id]);
  return json({ conversation: conv, messages });
});

export const DELETE = route<Ctx>(async (_req, { params }) => {
  const user = await requireUser();
  const { id } = await params;
  await query("DELETE FROM conversations WHERE id = $1 AND user_id = $2", [id, user.id]);
  return json({ ok: true });
});
