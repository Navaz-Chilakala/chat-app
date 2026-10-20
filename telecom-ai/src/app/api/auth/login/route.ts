import { z } from "zod";
import { route, json, parseBody, limit, HttpError } from "@/lib/http";
import { createSession, ensureBootstrapAdmin, setSessionCookie, verifyPassword } from "@/lib/auth/session";
import { query, queryOne } from "@/lib/db";

// `identifier` is an email address or a username; `email` is accepted for backwards compatibility.
const Body = z.object({ identifier: z.string().trim().min(1).max(200).optional(), email: z.string().trim().max(200).optional(), password: z.string().min(1).max(200) }).refine((b) => b.identifier || b.email, "identifier is required");
// Always run bcrypt so response time doesn't reveal whether the email exists.
const DUMMY_HASH = "$2a$12$CwTycUXWue0Thq9StjUM0uJ8.7rRrDfZWwtZ9d0rqT7Qb1H4J6m1u";

export const POST = route(async (req) => {
  await limit(req, null, "login", 20, 900);
  const body = await parseBody(req, Body);
  const identifier = (body.identifier ?? body.email)!;
  const password = body.password;
  await ensureBootstrapAdmin();
  const user = await queryOne<{ id: string; password_hash: string; display_name: string; is_admin: boolean; disabled_at: Date | null; label: string }>(
    "SELECT id, password_hash, display_name, is_admin, disabled_at, COALESCE(email::text, username::text) AS label FROM users WHERE email = $1 OR username = $1",
    [identifier],
  );
  const ok = await verifyPassword(password, user?.password_hash ?? DUMMY_HASH);
  if (!user || !ok || user.disabled_at) throw new HttpError(401, "Invalid username/email or password");
  const { token, expires } = await createSession(user.id);
  await setSessionCookie(token, expires);
  await query("INSERT INTO audit_events(user_id, action) VALUES ($1,'user.login')", [user.id]);
  return json({ user: { id: user.id, email: user.label, displayName: user.display_name, isAdmin: user.is_admin } });
});
