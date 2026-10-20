import { z } from "zod";
import { route, json, requireUser, parseBody } from "@/lib/http";
import { readableWorkspaceIds } from "@/lib/auth/access";
import { hybridSearch } from "@/lib/retrieval/search";
import { flowFromEvidence, curatedFlow } from "@/lib/flows/build";
import { CURATED_FLOWS } from "@/lib/flows/catalog";

const Body = z.object({ query: z.string().trim().min(2).max(500).optional(), flowId: z.string().max(60).optional() });

export const POST = route(async (req) => {
  const user = await requireUser();
  const ws = await readableWorkspaceIds(user);
  const b = await parseBody(req, Body);
  const curated = b.flowId ? CURATED_FLOWS.find((f) => f.id === b.flowId) : null;
  const q = b.query ?? (curated ? `${curated.title} procedure TS ${curated.spec} clause ${curated.clause}` : "");
  const search = await hybridSearch(q, { workspaceIds: ws, topK: 10, filters: curated ? { specNumbers: [curated.spec] } : undefined });
  const fromEvidence = await flowFromEvidence(search.evidence);
  const fromCatalog = await curatedFlow(curated ? curated.title : q, search.analysis.generation, ws);
  return json({ evidenceFlow: fromEvidence, curatedFlow: fromCatalog, evidence: search.evidence.slice(0, 8), gaps: search.gaps });
});
