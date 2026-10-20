import type { Evidence, SearchResult } from "../retrieval/search";
import type { FlowResult } from "../flows/types";
import { splitSentences } from "../ingest/chunk/common";
import { tokenize } from "../embeddings/local-hash";
import { isNormativeSentence, extractIdentifiers } from "../telecom/identifiers";

export interface Statement {
  text: string;
  citations: number[];
  kind: "quote" | "normative" | "definition" | "step" | "note";
}

export interface AnswerSection {
  id: string;
  title: string;
  statements?: Statement[];
  table?: { caption: string | null; markdown: string; citation: number };
  items?: { label: string; detail: string; citations: number[] }[];
}

export interface CompareColumn {
  label: string;
  statements: Statement[];
}

export interface ApiOperationSummary {
  citation: number;
  apiTitle: string;
  apiVersion: string | null;
  method: string;
  path: string;
  operationId: string | null;
  summary: string | null;
  parameters: { name: string; in: string; required: boolean; type: string }[];
  requestBody: string | null;
  responses: { code: string; description: string }[];
  security: string | null;
  specRefs: string[];
}

export interface Answer {
  status: "answered" | "partial" | "insufficient_evidence";
  confidence: "high" | "medium" | "low";
  summary: Statement[];
  sections: AnswerSection[];
  compare: CompareColumn[] | null;
  flow: FlowResult | null;
  apiOperations: ApiOperationSummary[];
  gaps: string[];
  conflicts: string[];
  evidence: Evidence[];
  notice: string;
}

export function citeLabel(e: Evidence): string {
  if (e.specNumber) {
    const parts = [`${e.specType ?? "TS"} ${e.specNumber}`];
    if (e.version) parts.push(`V${e.version}`);
    if (e.clause) parts.push(`§${e.clause}`);
    return parts.join(" ");
  }
  if (e.repoPath) return `${e.repoPath}${e.lineStart ? `:${e.lineStart}-${e.lineEnd}` : ""}${e.commitSha ? ` @${e.commitSha.slice(0, 8)}` : ""}`;
  return e.title;
}

interface ScoredSentence {
  text: string;
  evidence: Evidence;
  score: number;
  tokens: Set<string>;
  matched?: Set<string>; // query terms this sentence covers
}

function stemSet(text: string): Set<string> {
  return new Set(tokenize(text).map((w) => (w.length > 4 && !/\d/.test(w) ? w.replace(/(ations?|ments?|ings?|ies|ed|es|s)$/, "") : w)));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / Math.max(1, a.size + b.size - inter);
}

/** Score every sentence in the evidence against the query (IDF-weighted term + identifier coverage). */
export function scoreSentences(queryText: string, evidence: Evidence[], extraTerms: string[] = []): ScoredSentence[] {
  const qTerms = stemSet(`${queryText} ${extraTerms.join(" ")}`);
  const qIds = new Set(extractIdentifiers(queryText, { bareSpecNumbers: true }).filter((i) => !i.startsWith("spec:")));
  const sentences: ScoredSentence[] = [];
  for (const e of evidence) {
    if (e.chunkType === "code" || e.chunkType === "config" || e.flags.includes("suspicious_instructions") || e.flags.includes("boilerplate")) continue;
    const units = e.chunkType === "table" || e.chunkType === "abbreviation" || e.chunkType.startsWith("api_") ? e.content.split("\n") : e.content.split("\n").flatMap(splitSentences);
    for (const raw of units) {
      const text = raw.trim();
      if (text.length < (e.chunkType.startsWith("api_") ? 8 : 25) || text.length > 900 || /^\|?\s*-{3}/.test(text)) continue;
      sentences.push({ text, evidence: e, score: 0, tokens: stemSet(text) });
    }
  }
  const df = new Map<string, number>();
  for (const s of sentences) for (const t of s.tokens) df.set(t, (df.get(t) ?? 0) + 1);
  const N = Math.max(1, sentences.length);
  for (const s of sentences) {
    let sc = 0;
    s.matched = new Set([...qTerms].filter((t) => s.tokens.has(t)));
    for (const t of s.matched) sc += Math.log(1 + N / (df.get(t) ?? 1));
    const ids = extractIdentifiers(s.text);
    for (const id of ids) if (qIds.has(id)) sc += 3;
    sc /= Math.sqrt(Math.max(8, s.tokens.size)) / 2.5;
    sc *= 1 + 0.6 / s.evidence.n; // prefer higher-ranked evidence
    if (s.evidence.authorityTier === 1) sc *= 1.15;
    if (s.evidence.flags.includes("ocr")) sc *= 0.85;
    s.score = sc;
  }
  return sentences.sort((a, b) => b.score - a.score);
}

function mmrSelect(cands: ScoredSentence[], k: number, minScore: number): ScoredSentence[] {
  const out: ScoredSentence[] = [];
  for (const c of cands) {
    if (c.score < minScore) break;
    if (out.some((o) => jaccard(o.tokens, c.tokens) > 0.55)) continue;
    out.push(c);
    if (out.length >= k) break;
  }
  return out;
}

/**
 * Coverage-aware selection for the direct answer: each pick is rewarded for covering query terms that
 * earlier picks did not, so multi-part questions ("what is sent AND which timer starts") get a quote per part.
 */
function coverageSelect(cands: ScoredSentence[], k: number, minScore: number): ScoredSentence[] {
  const pool = cands.filter((c) => c.score >= minScore).slice(0, 80);
  const covered = new Set<string>();
  const out: ScoredSentence[] = [];
  while (out.length < k && pool.length) {
    let bestIdx = -1;
    let bestVal = -Infinity;
    pool.forEach((c, i) => {
      if (out.some((o) => jaccard(o.tokens, c.tokens) > 0.55)) return;
      const fresh = [...(c.matched ?? [])].filter((t) => !covered.has(t)).length;
      const val = c.score * (0.6 + fresh);
      if (val > bestVal) {
        bestVal = val;
        bestIdx = i;
      }
    });
    if (bestIdx < 0) break;
    const [pick] = pool.splice(bestIdx, 1);
    out.push(pick!);
    for (const t of pick!.matched ?? []) covered.add(t);
  }
  return out;
}

const toStatement = (s: ScoredSentence, kind: Statement["kind"] = "quote"): Statement => ({ text: s.text, citations: [s.evidence.n], kind });

export function compose(input: {
  search: SearchResult;
  flow: FlowResult | null;
  compareSearches?: { label: string; search: SearchResult }[];
  apiOperations?: ApiOperationSummary[];
}): Answer {
  const { search } = input;
  const a = search.analysis;
  const ev = search.evidence;
  const gaps = [...search.gaps];
  const conflicts: string[] = [];
  const notice =
    "Extractive answer: every statement below is quoted verbatim from the cited sources; no text is generated. Retrieval uses keyword, identifier and vector search, so always read the cited clause in full.";
  const expansionTerms = search.expansions.map((e) => e.expansion);

  if (a.injectionLike) gaps.push("The question contains instruction-like text. This system only retrieves and quotes documents; it does not follow instructions found in questions or documents.");

  // Identifier-like terms absent from the whole corpus => cannot be answered from evidence.
  const unknownIdentifierTerms = search.unknownTerms.filter((t) => /\d|[A-Z].*[A-Z]|-/.test(t));
  if (unknownIdentifierTerms.length) gaps.push(`These terms do not occur anywhere in the indexed knowledge base: ${unknownIdentifierTerms.join(", ")}.`);

  const ranked = scoreSentences(a.normalized, ev, expansionTerms);
  let top = coverageSelect(ranked, 4, 1.2);
  const bestScore = ranked[0]?.score ?? 0;

  // Explicitly requested clause: its verbatim text (document order) is the answer.
  const clauseEv = a.clauses.length
    ? ev
        .filter((e) => e.channels.includes("clause") && e.clause && a.clauses.some((c) => e.clause === c || e.clause!.startsWith(`${c}.`)))
        .sort((x, y) => (x.versionId === y.versionId ? x.ord - y.ord : 0))
    : [];
  if (clauseEv.length) {
    const lead = clauseEv.filter((e) => e.chunkType === "text").flatMap((e) => splitSentences(e.content).slice(0, 2).map((t) => ({ text: t, evidence: e, score: 10, tokens: stemSet(t) })));
    top = [...lead.slice(0, 3), ...top.filter((t) => !lead.some((l) => l.text === t.text))].slice(0, 4);
  }

  // Code questions: the answer is the list of matching implementation symbols (metadata, not generated prose).
  const codeEv = a.intents.includes("code") ? ev.filter((e) => (e.chunkType === "code" || e.chunkType === "config") && e.channels.some((c) => c === "ident" || c === "fts")) : [];
  const codeSummary: Statement[] = codeEv.slice(0, 5).map((e) => ({
    text: `${e.symbol ? `${e.symbol} — ` : ""}${e.repoPath ?? e.title}${e.lineStart ? ` lines ${e.lineStart}–${e.lineEnd}` : ""}${e.commitSha ? ` @ ${e.commitSha.slice(0, 12)}` : ""}`,
    citations: [e.n],
    kind: "note" as const,
  }));

  if (a.injectionLike || unknownIdentifierTerms.length > 0 || (!codeSummary.length && (!ev.length || !top.length))) {
    return {
      status: "insufficient_evidence",
      confidence: "low",
      summary: [],
      sections: ev.length ? [relatedSection(ev)] : [],
      compare: null,
      flow: input.flow?.origin === "curated" ? input.flow : null,
      apiOperations: [],
      gaps: [...gaps, "Insufficient evidence: no retrieved passage answers this question. Nothing has been inferred or invented. Try naming the specification, procedure or message, or ingest the relevant document."],
      conflicts,
      evidence: ev,
      notice,
    };
  }

  const sections: AnswerSection[] = [];
  if (clauseEv.length) {
    sections.push({
      id: "clause",
      title: `Clause ${a.clauses.join(", ")} — verbatim text`,
      statements: clauseEv.map((e) => ({ text: e.content.length > 2500 ? `${e.content.slice(0, 2500)}…` : e.content, citations: [e.n], kind: "quote" as const })),
    });
  }

  // "Which specification defines X?": list where the exact identifiers occur.
  if (/\bwhich (spec|specification|ts|document|standard)s?\b|\bwhere is .* defined\b|\bdefined in\b/i.test(a.normalized) && a.strongIdentifiers.length) {
    const hits = ev.filter((e) => e.channels.includes("ident"));
    if (hits.length) {
      sections.push({
        id: "defined-in",
        title: `Where ${a.strongIdentifiers.map((i) => i.split(":").slice(1).join(":")).join(", ")} occurs (exact identifier match)`,
        items: hits.slice(0, 10).map((e) => ({ label: citeLabel(e), detail: `${e.headingPath?.split(" > ").pop() ?? e.title}${e.flags.includes("normative") ? " — contains normative text" : ""}`, citations: [e.n] })),
      });
    }
  }

  // Definitions
  if (a.intents.includes("definition")) {
    const term = (a.definitionTerm ?? "").toLowerCase();
    const defs = term ? ev.filter((e) => e.chunkType === "definition" && (e.content.toLowerCase().startsWith(term) || e.content.toLowerCase().startsWith(`${term}:`) || e.content.toLowerCase().split(":")[0]!.includes(term))) : [];
    const abbr = ev.filter((e) => e.chunkType === "abbreviation").flatMap((e) =>
      e.content
        .split("\n")
        .filter((l) => term && l.toLowerCase().startsWith(`${term.split(" ")[0]} `))
        .map((l) => ({ text: l, citations: [e.n], kind: "definition" as const })),
    );
    const st = [...defs.slice(0, 3).map((e) => ({ text: e.content, citations: [e.n], kind: "definition" as const })), ...abbr.slice(0, 3)];
    if (st.length) sections.push({ id: "definitions", title: "Definitions and abbreviations (verbatim)", statements: st });
  }

  // Normative requirements (official sources only)
  const normative = mmrSelect(
    ranked.filter((s) => s.evidence.authorityTier <= 2 && isNormativeSentence(s.text) && /\bshall\b|\bmust\b/i.test(s.text)),
    8,
    0.8,
  );
  if (normative.length) sections.push({ id: "normative", title: "Normative requirements (shall / shall not)", statements: normative.map((s) => toStatement(s, "normative")) });

  // Procedure steps as written in the source
  if (a.intents.includes("procedure") || a.intents.includes("failure")) {
    if (input.flow?.origin === "evidence") {
      sections.push({
        id: "steps",
        title: `Step-by-step, as written in ${input.flow.spec ? `TS ${input.flow.spec} §${input.flow.clause}` : "the source"}`,
        statements: input.flow.steps.map((s) => ({ text: s.sourceText ?? `${s.label}. ${s.from} to ${s.to}: ${s.message}`, citations: s.citation ? [s.citation] : [], kind: "step" as const })),
      });
    } else {
      const stepLines: Statement[] = [];
      for (const e of ev.slice(0, 6)) {
        for (const line of e.content.split("\n")) if (/^\d{1,2}[a-z]?\.\s+\S/.test(line.trim()) && stepLines.length < 30) stepLines.push({ text: line.trim(), citations: [e.n], kind: "step" });
        if (stepLines.length >= 4) break;
      }
      if (stepLines.length >= 2) sections.push({ id: "steps", title: "Numbered steps found in the retrieved text", statements: stepLines });
    }
  }

  // Failure / abnormal cases
  const failures = mmrSelect(ranked.filter((s) => /\b(reject|fail|abnormal|expir|cause|not accepted|unsuccessful|error)\w*/i.test(s.text)), 6, 0.8);
  if (failures.length && (a.intents.includes("failure") || a.intents.includes("procedure"))) {
    sections.push({ id: "failures", title: "Failure and abnormal cases", statements: failures.map((s) => toStatement(s)) });
  }

  // Identifiers present in the evidence (messages, IEs, timers, interfaces, services)
  const idMap = new Map<string, Set<number>>();
  for (const e of ev) for (const id of e.identifiers) if (/^(msg|timer|ie|svc|if|cause):/.test(id)) {
    if (!idMap.has(id)) idMap.set(id, new Set());
    idMap.get(id)!.add(e.n);
  }
  const KIND: Record<string, string> = { msg: "Message", timer: "Timer", ie: "Information element", svc: "SBI service operation", if: "Interface / reference point", cause: "Cause value" };
  const idItems = [...idMap]
    .sort((x, y) => y[1].size - x[1].size)
    .slice(0, 24)
    .map(([id, ns]) => ({ label: id.split(":").slice(1).join(":"), detail: KIND[id.split(":")[0]!] ?? id.split(":")[0]!, citations: [...ns].sort((p, q) => p - q) }));
  if (idItems.length) sections.push({ id: "identifiers", title: "Messages, IEs, timers and interfaces mentioned in the evidence", items: idItems });

  // Tables
  for (const e of ev.filter((x) => x.chunkType === "table").slice(0, 2)) {
    const caption = e.content.startsWith("Table") ? e.content.split("\n")[0]! : null;
    sections.push({ id: `table-${e.n}`, title: caption ?? `Table from ${citeLabel(e)}`, table: { caption, markdown: caption ? e.content.split("\n").slice(1).join("\n") : e.content, citation: e.n } });
  }

  // OCR figures
  const figs = ev.filter((e) => e.chunkType === "figure_ocr").slice(0, 3);
  if (figs.length) sections.push({ id: "figures", title: "Figures (OCR text — machine-extracted, verify against the original)", statements: figs.map((e) => ({ text: e.content.split("\n").slice(1).join("\n").slice(0, 800), citations: [e.n], kind: "note" as const })) });

  // Code
  const code = ev.filter((e) => e.chunkType === "code" || e.chunkType === "config").slice(0, 5);
  if (code.length) {
    sections.push({
      id: "code",
      title: "Implementation references (reference implementations — not normative)",
      items: code.map((e) => ({ label: `${e.symbol ?? e.repoPath ?? e.title}`, detail: `${e.repoPath ?? e.title}${e.lineStart ? ` lines ${e.lineStart}–${e.lineEnd}` : ""}${e.commitSha ? ` @ ${e.commitSha.slice(0, 12)}` : ""}${e.license ? ` (${e.license})` : ""}`, citations: [e.n] })),
    });
    if (a.intents.includes("code") && !ev.some((e) => e.authorityTier === 1)) gaps.push("Implementation behaviour shown here has not been compared with normative text (no specification evidence retrieved). Correspondence is: not enough evidence.");
  }

  // Release/version conflicts: never merge statements from different versions of the same spec silently.
  const versionsBySpec = new Map<string, Set<string>>();
  for (const e of ev) if (e.specNumber && e.version) {
    if (!versionsBySpec.has(e.specNumber)) versionsBySpec.set(e.specNumber, new Set());
    versionsBySpec.get(e.specNumber)!.add(`${e.version}${e.release ? ` (Rel-${e.release})` : ""}`);
  }
  for (const [spec, vs] of versionsBySpec) if (vs.size > 1) conflicts.push(`Evidence for ${spec} comes from multiple versions: ${[...vs].join(", ")}. Statements are labelled per version; they may differ between releases.`);

  // Compare columns
  let compare: CompareColumn[] | null = null;
  if (input.compareSearches?.length === 2) {
    compare = input.compareSearches.map(({ label, search: s }) => {
      const sents = mmrSelect(scoreSentences(label, s.evidence), 4, 0.8);
      return { label, statements: sents.map((x) => ({ text: x.text, citations: [ev.find((e) => e.chunkId === x.evidence.chunkId)?.n ?? x.evidence.n], kind: "quote" as const })) };
    });
  }

  sections.push(relatedSection(ev));
  const officialTop = top.some((s) => s.evidence.authorityTier === 1);
  const strongExact = (search.channelCounts.clause ?? 0) > 0 || (search.channelCounts.ident ?? 0) > 0;
  const confidence: Answer["confidence"] = bestScore > 6 && officialTop && strongExact ? "high" : bestScore > 3 ? "medium" : "low";
  return {
    status: gaps.some((g) => g.startsWith("TS/TR") || g.includes("not indexed")) || confidence === "low" ? "partial" : "answered",
    confidence,
    summary: codeSummary.length ? [...codeSummary, ...top.filter((t) => t.evidence.authorityTier <= 2).slice(0, 2).map((s) => toStatement(s))] : top.map((s) => toStatement(s)),
    sections,
    compare,
    flow: input.flow,
    apiOperations: input.apiOperations ?? [],
    gaps,
    conflicts,
    evidence: ev,
    notice,
  };
}

function relatedSection(ev: Evidence[]): AnswerSection {
  const seen = new Set<string>();
  const items: AnswerSection["items"] = [];
  for (const e of ev) {
    const key = `${e.documentId}:${e.clause ?? e.headingPath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ label: citeLabel(e), detail: e.headingPath?.split(" > ").slice(-1)[0] ?? e.title, citations: [e.n] });
  }
  return { id: "related", title: "Where this comes from (retrieved clauses and sources)", items: items.slice(0, 12) };
}
