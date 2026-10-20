import { z } from "zod";
import { route, json, parseBody, limit, HttpError } from "@/lib/http";
import { createSession, setSessionCookie, verifyPassword } from "@/lib/auth/session";
import { query, queryOne } from "@/lib/db";

const Body = z.object({ email: z.string().email().max(200), password: z.string().min(1).max(200) });
// Always run bcrypt so response time doesn't reveal whether the email exists.
const DUMMY_HASH = "$2a$12$CwTycUXWue0Thq9StjUM0uJ8.7rRrDfZWwtZ9d0rqT7Qb1H4J6m1u";

export const POST = route(async (req) => {
  await limit(req, null, "login", 20, 900);
  const { email, password } = await parseBody(req, Body);
  const user = await queryOne<{ id: string; password_hash: string; display_name: string; is_admin: boolean; disabled_at: Date | null }>(
    "SELECT id, password_hash, display_name, is_admin, disabled_at FROM users WHERE email = $1",
    [email.toLowerCase()],
  );
  const ok = await verifyPassword(password, user?.password_hash ?? DUMMY_HASH);
  if (!user || !ok || user.disabled_at) throw new HttpError(401, "Invalid email or password");
  const { token, expires } = await createSession(user.id);
  await setSessionCookie(token, expires);
  await query("INSERT INTO audit_events(user_id, action) VALUES ($1,'user.login')", [user.id]);
  return json({ user: { id: user.id, email: email.toLowerCase(), displayName: user.display_name, isAdmin: user.is_admin } });
});
