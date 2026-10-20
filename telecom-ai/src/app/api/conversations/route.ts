import { route, json, requireUser } from "@/lib/http";
import { query } from "@/lib/db";

export const GET = route(async () => {
  const user = await requireUser();
  const rows = await query("SELECT id, title, created_at, updated_at FROM conversations WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 100", [user.id]);
  return json({ conversations: rows });
});
