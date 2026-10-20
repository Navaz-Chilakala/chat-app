import { z } from "zod";
import { route, parseBody, requireUser, limit, HttpError } from "@/lib/http";
import { readableWorkspaceIds } from "@/lib/auth/access";
import { ask, logRetrieval } from "@/lib/answer/engine";
import { query, queryOne } from "@/lib/db";
import { errorMessage, logger } from "@/lib/logger";

export const maxDuration = 60;

const Filters = z
  .object({
    specNumbers: z.array(z.string().regex(/^\d{2}\.\d{3}(-\d+)?$/)).max(20).optional(),
    releases: z.array(z.number().int().min(4).max(25)).max(10).optional(),
    sourceTypes: z.array(z.string().max(40)).max(10).optional(),
    maxTier: z.number().int().min(1).max(4).optional(),
    tags: z.array(z.string().max(30)).max(10).optional(),
    mode: z.enum(["latest", "historical", "auto"]).optional(),
  })
  .optional();

const Body = z.object({
  message: z.string().trim().min(1).max(4000),
  conversationId: z.string().uuid().optional(),
  workspaceIds: z.array(z.string().uuid()).max(20).optional(),
  filters: Filters,
});

/**
 * Streams NDJSON events: {type:"meta"} -> {type:"evidence"} -> {type:"answer"} -> {type:"done"}.
 * No LLM is involved; streaming lets the UI show retrieval progress and evidence before the composed answer.
 */
export const POST = route(async (req) => {
  const user = await requireUser();
  await limit(req, user, "chat", 60, 60);
  const body = await parseBody(req, Body);
  const workspaceIds = await readableWorkspaceIds(user, body.workspaceIds);
  if (!workspaceIds.length) throw new HttpError(403, "No accessible workspace");

  let conversationId = body.conversationId;
  if (conversationId) {
    const conv = await queryOne("SELECT 1 FROM conversations WHERE id = $1 AND user_id = $2", [conversationId, user.id]);
    if (!conv) throw new HttpError(404, "Conversation not found");
  } else {
    const row = await queryOne<{ id: string }>("INSERT INTO conversations(workspace_id, user_id, title) VALUES ($1,$2,$3) RETURNING id", [workspaceIds[0], user.id, body.message.slice(0, 80)]);
    conversationId = row!.id;
  }
  const history = (await query<{ content: string }>("SELECT content FROM messages WHERE conversation_id = $1 AND role = 'user' ORDER BY created_at DESC LIMIT 3", [conversationId])).map((r) => r.content).reverse();
  await query("INSERT INTO messages(conversation_id, role, content, filters) VALUES ($1,'user',$2,$3)", [conversationId, body.message, body.filters ?? null]);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(encoder.encode(`${JSON.stringify(obj)}\n`));
      try {
        send({ type: "meta", conversationId });
        const { answer, search, effectiveQuery } = await ask(body.message, { workspaceIds, filters: body.filters, userId: user.id, history });
        send({ type: "evidence", evidence: answer.evidence, analysis: search.analysis, channels: search.channelCounts, mode: search.mode, vectorModel: search.vectorModel, effectiveQuery });
        const msg = await queryOne<{ id: string }>("INSERT INTO messages(conversation_id, role, content, answer) VALUES ($1,'assistant',$2,$3) RETURNING id", [
          conversationId,
          answer.summary.map((s) => s.text).join(" ").slice(0, 4000) || answer.gaps.join(" "),
          JSON.stringify(answer),
        ]);
        await query("UPDATE conversations SET updated_at = now() WHERE id = $1", [conversationId]);
        await logRetrieval({ workspaceId: workspaceIds[0]!, userId: user.id, messageId: msg!.id, search }).catch(() => undefined);
        send({ type: "answer", messageId: msg!.id, answer, latencyMs: search.latencyMs });
        send({ type: "done" });
      } catch (err) {
        logger.error("chat.failed", { error: errorMessage(err) });
        send({ type: "error", error: "The question could not be processed. Please try again." });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" } });
});
