import { z } from "zod";
import { route, json, parseBody, requireUser, limit } from "@/lib/http";
import { readableWorkspaceIds } from "@/lib/auth/access";
import { hybridSearch } from "@/lib/retrieval/search";

const Body = z.object({
  query: z.string().trim().min(1).max(2000),
  topK: z.number().int().min(1).max(50).optional(),
  workspaceIds: z.array(z.string().uuid()).optional(),
  filters: z
    .object({
      specNumbers: z.array(z.string().max(12)).max(20).optional(),
      releases: z.array(z.number().int()).max(10).optional(),
      sourceTypes: z.array(z.string().max(40)).max(10).optional(),
      maxTier: z.number().int().min(1).max(4).optional(),
      tags: z.array(z.string().max(30)).max(10).optional(),
      chunkTypes: z.array(z.string().max(30)).max(10).optional(),
      mode: z.enum(["latest", "historical", "auto"]).optional(),
    })
    .optional(),
});

export const POST = route(async (req) => {
  const user = await requireUser();
  await limit(req, user, "search", 120, 60);
  const b = await parseBody(req, Body);
  const ws = await readableWorkspaceIds(user, b.workspaceIds);
  const result = await hybridSearch(b.query, { workspaceIds: ws, filters: b.filters, topK: b.topK ?? 20, contextBudgetTokens: 20000 });
  return json(result);
});
