import { z } from "zod";
import { route, json, parseBody, requireUser, HttpError } from "@/lib/http";
import { query, queryOne } from "@/lib/db";

const Body = z.object({ messageId: z.string().uuid(), rating: z.union([z.literal(1), z.literal(-1)]), comment: z.string().max(2000).optional() });

export const POST = route(async (req) => {
  const user = await requireUser();
  const b = await parseBody(req, Body);
  const own = await queryOne("SELECT 1 FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.id = $1 AND c.user_id = $2", [b.messageId, user.id]);
  if (!own) throw new HttpError(404, "Message not found");
  await query(
    "INSERT INTO feedback(message_id, user_id, rating, comment) VALUES ($1,$2,$3,$4) ON CONFLICT (message_id, user_id) DO UPDATE SET rating = EXCLUDED.rating, comment = EXCLUDED.comment",
    [b.messageId, user.id, b.rating, b.comment ?? null],
  );
  return json({ ok: true });
});
