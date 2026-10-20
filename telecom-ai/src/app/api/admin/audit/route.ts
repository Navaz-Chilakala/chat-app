import { route, json, requireAdmin } from "@/lib/http";
import { query } from "@/lib/db";

export const GET = route(async () => {
  await requireAdmin();
  const events = await query("SELECT a.id, a.action, a.target_type, a.target_id, a.data, a.created_at, u.email FROM audit_events a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT 300");
  return json({ events });
});
