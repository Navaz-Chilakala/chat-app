import { z } from "zod";
import { route, json, parseBody, limit, HttpError } from "@/lib/http";
import { createSession, registerUser, setSessionCookie } from "@/lib/auth/session";

const Body = z.object({
  email: z.string().email().max(200),
  password: z.string().min(10, "Password must be at least 10 characters").max(200),
  displayName: z.string().trim().min(1).max(80),
});

export const POST = route(async (req) => {
  await limit(req, null, "signup", 10, 3600);
  const body = await parseBody(req, Body);
  try {
    const user = await registerUser(body.email.toLowerCase(), body.password, body.displayName);
    const { token, expires } = await createSession(user.id);
    await setSessionCookie(token, expires);
    return json({ user });
  } catch (err) {
    const m = (err as Error).message;
    if (m === "EMAIL_TAKEN") throw new HttpError(409, "An account with this email already exists");
    if (m === "SIGNUP_NOT_ALLOWED") throw new HttpError(403, "Sign-up is invite-only on this deployment");
    throw err;
  }
});
