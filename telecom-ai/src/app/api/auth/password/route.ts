import { z } from "zod";
import { route, json, parseBody, requireUser, limit, HttpError } from "@/lib/http";
import { SESSION_COOKIE, hashPassword, hashToken, verifyPassword } from "@/lib/auth/session";
import { query, queryOne } from "@/lib/db";

const Body = z.object({ currentPassword: z.string().min(1).max(200), newPassword: z.string().min(10, "New password must be at least 10 characters").max(200) });

/** Change your own password; other sessions of the account are signed out. */
export const POST = route(async (req) => {
  const user = await requireUser();
  await limit(req, user, "password", 10, 900);
  const b = await parseBody(req, Body);
  const row = await queryOne<{ password_hash: string }>("SELECT password_hash FROM users WHERE id = $1", [user.id]);
  if (!row || !(await verifyPassword(b.currentPassword, row.password_hash))) throw new HttpError(400, "Current password is incorrect");
  if (b.currentPassword === b.newPassword) throw new HttpError(400, "New password must differ from the current one");
  await query("UPDATE users SET password_hash = $2 WHERE id = $1", [user.id, await hashPassword(b.newPassword)]);
  const current = req.cookies.get(SESSION_COOKIE)?.value;
  await query("DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2", [user.id, current ? hashToken(current) : ""]);
  await query("INSERT INTO audit_events(user_id, action) VALUES ($1,'user.password_changed')", [user.id]);
  return json({ ok: true });
});
