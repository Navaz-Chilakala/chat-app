import { route, json } from "@/lib/http";
import { destroySession } from "@/lib/auth/session";

export const POST = route(async () => {
  await destroySession();
  return json({ ok: true });
});
