import { query } from "../db";
import { hybridSearch, type SearchFilters, type SearchResult } from "../retrieval/search";
import { analyzeQuery } from "../retrieval/analyze";
import { compose, type Answer, type ApiOperationSummary } from "./compose";
import { curatedFlow, flowFromEvidence } from "../flows/build";
import type { FlowResult } from "../flows/types";

export interface AskOptions {
  workspaceIds: string[];
  filters?: SearchFilters;
  userId?: string | null;
  history?: string[]; // previous user questions in the conversation (for follow-ups)
  topK?: number;
}

/** Follow-up support: if a question is elliptical ("what about failures?"), carry the previous topic's identifiers. */
export function contextualizeQuery(q: string, history: string[] = []): string {
  const prev = history[history.length - 1];
  if (!prev) return q;
  const a = analyzeQuery(q);
  const elliptical = a.keywords.length <= 3 && !a.specNumbers.length && !a.strongIdentifiers.length && /^(and|what about|how about|also|then|and if|what if|why|which)\b/i.test(q.trim());
  return elliptical ? `${q} (${prev})` : q;
}

async function apiSummaries(search: SearchResult): Promise<ApiOperationSummary[]> {
  const ops = search.evidence.filter((e) => e.chunkType === "api_operation").slice(0, 4);
  if (!ops.length) return [];
  const rows = await query<{
    chunk_id: string; api_title: string; api_version: string | null; method: string; path: string; operation_id: string | null; summary: string | null;
    parameters: { name?: string; in?: string; required?: boolean; schema?: { type?: string; $ref?: string } }[]; request_body: { content?: Record<string, { schema?: { $ref?: string; type?: string } }> } | null;
    responses: Record<string, { description?: string; $ref?: string }>; security: unknown;
  }>("SELECT * FROM api_operations WHERE chunk_id = ANY($1)", [ops.map((o) => o.chunkId)]);
  return rows.map((r) => {
    const e = ops.find((o) => o.chunkId === r.chunk_id)!;
    const body = r.request_body?.content ? Object.entries(r.request_body.content).map(([ct, m]) => `${ct}: ${m.schema?.$ref?.split("/").pop() ?? m.schema?.type ?? "object"}`).join("; ") : null;
    return {
      citation: e.n,
      apiTitle: r.api_title,
      apiVersion: r.api_version,
      method: r.method,
      path: r.path,
      operationId: r.operation_id,
      summary: r.summary,
      parameters: (r.parameters ?? []).map((p) => ({ name: String(p.name), in: String(p.in), required: !!p.required, type: p.schema?.$ref?.split("/").pop() ?? p.schema?.type ?? "any" })),
      requestBody: body,
      responses: Object.entries(r.responses ?? {}).map(([code, v]) => ({ code, description: String(v?.description ?? v?.$ref?.split("/").pop() ?? "") })),
      security: r.security ? JSON.stringify(r.security) : null,
      specRefs: e.identifiers.filter((i) => i.startsWith("spec:")).map((i) => i.slice(5)),
    };
  });
}

export async function ask(question: string, opts: AskOptions): Promise<{ answer: Answer; search: SearchResult; effectiveQuery: string }> {
  const effectiveQuery = contextualizeQuery(question, opts.history);
  const analysis = analyzeQuery(effectiveQuery);
  const search = await hybridSearch(effectiveQuery, { workspaceIds: opts.workspaceIds, filters: opts.filters, topK: opts.topK ?? 12, analysis });

  let flow: FlowResult | null = null;
  if (analysis.intents.includes("procedure")) {
    flow = (await flowFromEvidence(search.evidence)) ?? (await curatedFlow(effectiveQuery, analysis.generation, opts.workspaceIds));
  }

  let compareSearches: { label: string; search: SearchResult }[] | undefined;
  if (analysis.compareParts) {
    compareSearches = [];
    for (const part of analysis.compareParts) {
      const s = await hybridSearch(part, { workspaceIds: opts.workspaceIds, filters: opts.filters, topK: 5 });
      compareSearches.push({ label: part, search: s });
      // Merge per-part evidence into the main evidence list so every citation number resolves.
      for (const e of s.evidence) {
        if (!search.evidence.some((x) => x.chunkId === e.chunkId)) search.evidence.push({ ...e, n: search.evidence.length + 1 });
      }
    }
    for (const c of compareSearches) c.search.evidence = c.search.evidence.map((e) => search.evidence.find((x) => x.chunkId === e.chunkId)!);
  }

  const apiOperations = await apiSummaries(search);
  const answer = compose({ search, flow, compareSearches, apiOperations });
  return { answer, search, effectiveQuery };
}

export async function logRetrieval(input: { workspaceId: string | null; userId: string | null; messageId: string | null; search: SearchResult }) {
  await query("INSERT INTO retrieval_events(workspace_id, user_id, message_id, query, analysis, results, latency_ms) VALUES ($1,$2,$3,$4,$5,$6,$7)", [
    input.workspaceId,
    input.userId,
    input.messageId,
    input.search.analysis.original.slice(0, 2000),
    { ...input.search.analysis, mode: input.search.mode, gaps: input.search.gaps, channels: input.search.channelCounts, vectorModel: input.search.vectorModel },
    input.search.evidence.map((e) => ({ chunkId: e.chunkId, score: e.score, channels: e.channels, spec: e.specNumber, clause: e.clause })),
    input.search.latencyMs,
  ]);
}
