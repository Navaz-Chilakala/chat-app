import { route, json, requireUser } from "@/lib/http";
import { query } from "@/lib/db";

export const GET = route(async () => {
  const user = await requireUser();
  const rows = await query("SELECT id, title, created_at, updated_at FROM conversations WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 100", [user.id]);
  return json({ conversations: rows });
});

/** Delete all of the caller's conversations (their messages cascade). */
export const DELETE = route(async () => {
  const user = await requireUser();
  const rows = await query<{ id: string }>("DELETE FROM conversations WHERE user_id = $1 RETURNING id", [user.id]);
  return json({ ok: true, deleted: rows.length });
});
