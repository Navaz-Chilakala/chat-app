import { query, queryOne } from "../db";
import { hybridSearch, type Evidence } from "../retrieval/search";
import { ask } from "../answer/engine";

export interface CaseResult {
  name: string;
  category: string;
  query: string;
  status: "pass" | "fail" | "skipped";
  reason?: string;
  rank: number | null; // 1-based rank of first relevant result
  recallAt5: number | null;
  recallAt10: number | null;
  ndcgAt10: number | null;
  citationFaithfulness: number | null; // fraction of quoted statements found verbatim in their cited evidence
  citationCoverage: number | null; // fraction of statements carrying a citation
  latencyMs: number;
}

function relevant(e: Evidence, exp: { spec_number?: string; clause_prefix?: string; identifiers?: string[]; chunk_type?: string }): boolean {
  if (exp.spec_number && e.specNumber !== exp.spec_number) return false;
  if (exp.clause_prefix && !(e.clause === exp.clause_prefix || e.clause?.startsWith(`${exp.clause_prefix}.`) || e.clause?.startsWith(exp.clause_prefix))) return false;
  if (exp.identifiers?.length && !exp.identifiers.some((i) => e.identifiers.includes(i))) return false;
  if (exp.chunk_type && e.chunkType !== exp.chunk_type) return false;
  return true;
}

export async function runEvaluation(workspaceIds: string[]): Promise<{ id: string; metrics: Record<string, number | null>; results: CaseResult[] }> {
  const cases = await query<{ name: string; category: string; query: string; expected: Record<string, unknown> }>("SELECT name, category, query, expected FROM evaluation_cases ORDER BY name");
  const run = await queryOne<{ id: string }>("INSERT INTO evaluation_runs(config) VALUES ($1) RETURNING id", [{ workspaceIds: workspaceIds.length }]);
  const results: CaseResult[] = [];
  for (const c of cases) {
    const exp = c.expected as { spec_number?: string; clause_prefix?: string; identifiers?: string[]; expect_insufficient?: boolean; chunk_type?: string };
    const t0 = Date.now();
    if (exp.spec_number) {
      const indexed = await queryOne("SELECT 1 FROM documents WHERE spec_number = $1 AND workspace_id = ANY($2) AND current_version_id IS NOT NULL", [exp.spec_number, workspaceIds]);
      if (!indexed) {
        results.push({ name: c.name, category: c.category, query: c.query, status: "skipped", reason: `TS ${exp.spec_number} not indexed`, rank: null, recallAt5: null, recallAt10: null, ndcgAt10: null, citationFaithfulness: null, citationCoverage: null, latencyMs: 0 });
        continue;
      }
    }
    if (exp.expect_insufficient) {
      const { answer } = await ask(c.query, { workspaceIds });
      const ok = answer.status === "insufficient_evidence";
      results.push({ name: c.name, category: c.category, query: c.query, status: ok ? "pass" : "fail", reason: ok ? undefined : `expected insufficient_evidence, got ${answer.status}`, rank: null, recallAt5: null, recallAt10: null, ndcgAt10: null, citationFaithfulness: null, citationCoverage: null, latencyMs: Date.now() - t0 });
      continue;
    }
    const search = await hybridSearch(c.query, { workspaceIds, topK: 10 });
    const rels = search.evidence.map((e) => relevant(e, exp));
    const firstIdx = rels.indexOf(true);
    const totalRel = Math.max(1, rels.filter(Boolean).length);
    const dcg = rels.reduce((s, r, i) => s + (r ? 1 / Math.log2(i + 2) : 0), 0);
    const idcg = Array.from({ length: Math.min(10, totalRel) }, (_, i) => 1 / Math.log2(i + 2)).reduce((a, b) => a + b, 0);
    const { answer } = await ask(c.query, { workspaceIds });
    const statements = [...answer.summary, ...answer.sections.flatMap((s) => s.statements ?? [])].filter((s) => s.kind !== "note");
    const faithful = statements.filter((s) => s.citations.length && s.citations.every((n) => {
      const ev = answer.evidence.find((e) => e.n === n);
      return ev && (ev.content.includes(s.text) || ev.content.replace(/\s+/g, " ").includes(s.text.replace(/\s+/g, " ")) || s.text.replace(/…$/, "").length > 0 && ev.content.startsWith(s.text.replace(/…$/, "").slice(0, 200)));
    })).length;
    const cited = statements.filter((s) => s.citations.length).length;
    results.push({
      name: c.name,
      category: c.category,
      query: c.query,
      status: firstIdx >= 0 && firstIdx < 5 ? "pass" : "fail",
      reason: firstIdx < 0 ? "no relevant result in top 10" : firstIdx >= 5 ? `first relevant result at rank ${firstIdx + 1}` : undefined,
      rank: firstIdx >= 0 ? firstIdx + 1 : null,
      recallAt5: rels.slice(0, 5).some(Boolean) ? 1 : 0,
      recallAt10: rels.some(Boolean) ? 1 : 0,
      ndcgAt10: idcg ? dcg / idcg : 0,
      citationFaithfulness: statements.length ? faithful / statements.length : null,
      citationCoverage: statements.length ? cited / statements.length : null,
      latencyMs: Date.now() - t0,
    });
  }
  const scored = results.filter((r) => r.status !== "skipped" && r.recallAt5 !== null);
  const avg = (xs: (number | null)[]) => {
    const v = xs.filter((x): x is number => x !== null);
    return v.length ? Number((v.reduce((a, b) => a + b, 0) / v.length).toFixed(4)) : null;
  };
  const metrics = {
    cases: results.length,
    evaluated: results.filter((r) => r.status !== "skipped").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    passed: results.filter((r) => r.status === "pass").length,
    recallAt5: avg(scored.map((r) => r.recallAt5)),
    recallAt10: avg(scored.map((r) => r.recallAt10)),
    mrr: avg(scored.map((r) => (r.rank ? 1 / r.rank : 0))),
    ndcgAt10: avg(scored.map((r) => r.ndcgAt10)),
    citationFaithfulness: avg(scored.map((r) => r.citationFaithfulness)),
    citationCoverage: avg(scored.map((r) => r.citationCoverage)),
    refusalAccuracy: avg(results.filter((r) => r.category === "unanswerable" || r.category === "prompt_injection").map((r) => (r.status === "pass" ? 1 : r.status === "fail" ? 0 : null))),
    meanLatencyMs: avg(results.filter((r) => r.status !== "skipped").map((r) => r.latencyMs)),
  };
  await query("UPDATE evaluation_runs SET finished_at = now(), metrics = $2, results = $3 WHERE id = $1", [run!.id, metrics, JSON.stringify(results)]);
  return { id: run!.id, metrics, results };
}
