import { query, tx } from "../db";
import { analyzeQuery, type QueryAnalysis } from "./analyze";
import { activeEmbeddingModel, embeddingProvider, toVectorLiteral } from "../embeddings";
import { logger, errorMessage } from "../logger";

export interface SearchFilters {
  specNumbers?: string[];
  releases?: number[];
  sourceTypes?: string[];
  maxTier?: number; // 1 = official only
  tags?: string[];
  chunkTypes?: string[];
  mode?: "latest" | "historical" | "auto";
}

export interface Evidence {
  n: number;
  chunkId: string;
  documentId: string;
  versionId: string;
  title: string;
  specNumber: string | null;
  specType: string | null;
  version: string | null;
  release: number | null;
  isCurrent: boolean;
  clause: string | null;
  headingPath: string | null;
  sectionId: string | null;
  pageStart: number | null;
  pageEnd: number | null;
  sourceType: string;
  authorityTier: number;
  sourceUrl: string | null;
  chunkType: string;
  content: string;
  contextBefore: string | null;
  contextAfter: string | null;
  score: number;
  channels: string[];
  flags: string[];
  identifiers: string[];
  symbol: string | null;
  language: string | null;
  lineStart: number | null;
  lineEnd: number | null;
  repoPath: string | null;
  commitSha: string | null;
  license: string | null;
  ord: number;
}

export interface SearchResult {
  analysis: QueryAnalysis;
  evidence: Evidence[];
  gaps: string[];
  unknownTerms: string[];
  channelCounts: Record<string, number>;
  expansions: { abbr: string; expansion: string }[];
  mode: "latest" | "historical";
  latencyMs: number;
  vectorModel: string | null;
}

interface Candidate {
  id: string;
  rank: number;
  channel: string;
}

const CHANNEL_WEIGHTS: Record<string, number> = { clause: 3.0, ident: 1.6, fts: 1.0, vector: 0.8, symbol: 1.4 };
const RRF_K = 60;

function filterSql(filters: SearchFilters, mode: "latest" | "historical", args: unknown[], alias = "c"): string {
  const parts = [`${alias}.searchable`, `${alias}.workspace_id = ANY($1)`];
  if (mode === "latest") parts.push(`${alias}.is_current`);
  const add = (v: unknown) => {
    args.push(v);
    return `$${args.length}`;
  };
  if (filters.specNumbers?.length) parts.push(`${alias}.spec_number = ANY(${add(filters.specNumbers)})`);
  if (filters.releases?.length) parts.push(`${alias}.release = ANY(${add(filters.releases)})`);
  if (filters.sourceTypes?.length) parts.push(`${alias}.source_type = ANY(${add(filters.sourceTypes)})`);
  if (filters.maxTier) parts.push(`${alias}.authority_tier <= ${add(filters.maxTier)}`);
  if (filters.tags?.length) parts.push(`${alias}.tags && ${add(filters.tags)}`);
  if (filters.chunkTypes?.length) parts.push(`${alias}.chunk_type = ANY(${add(filters.chunkTypes)})`);
  return parts.join(" AND ");
}

async function loadExpansions(a: QueryAnalysis, workspaceIds: string[]) {
  const abbrs = [...new Set(a.normalized.match(/\b[A-Z][A-Z0-9-]{1,9}\b/g) ?? [])].slice(0, 12);
  if (!abbrs.length) return [];
  const rows = await query<{ abbr: string; expansion: string }>(
    `SELECT DISTINCT ON (lower(a.abbr), lower(a.expansion)) a.abbr, a.expansion FROM abbreviations a
     JOIN document_chunks c ON c.id = a.chunk_id
     WHERE lower(a.abbr) = ANY($1) AND a.workspace_id = ANY($2) AND c.searchable AND c.is_current
     ORDER BY lower(a.abbr), lower(a.expansion), c.authority_tier LIMIT 30`,
    [abbrs.map((x) => x.toLowerCase()), workspaceIds],
  );
  // At most 2 expansions per abbreviation (avoid drowning the query in ambiguous meanings).
  const per = new Map<string, number>();
  return rows.filter((r) => {
    const k = r.abbr.toLowerCase();
    per.set(k, (per.get(k) ?? 0) + 1);
    return per.get(k)! <= 2;
  });
}

/** Terms that never occur in the searchable corpus: a strong signal of insufficient evidence. */
async function findUnknownTerms(a: QueryAnalysis, workspaceIds: string[]): Promise<string[]> {
  const salient = [...new Set(a.normalized.match(/\b[A-Za-z]*\d[\w-]*\b|\b[A-Z][A-Za-z0-9]*-[A-Za-z0-9-]+\b|\b[A-Z]{2,}[a-z]*[A-Z]\w*\b/g) ?? [])]
    .filter((t) => !/^(TS|TR|Rel|V)\d*/i.test(t) && !/^\d+(\.\d+)*$/.test(t) && t.length >= 3)
    .slice(0, 8);
  const unknown: string[] = [];
  for (const t of salient) {
    const r = await query(
      `SELECT 1 FROM document_chunks c WHERE c.searchable AND c.workspace_id = ANY($1)
       AND (c.fts @@ plainto_tsquery('simple', $2) OR c.fts @@ plainto_tsquery('english', $2)) LIMIT 1`,
      [workspaceIds, t],
    );
    if (!r.length) unknown.push(t);
  }
  return unknown;
}

export async function hybridSearch(
  rawQuery: string,
  opts: { workspaceIds: string[]; filters?: SearchFilters; topK?: number; contextBudgetTokens?: number; analysis?: QueryAnalysis },
): Promise<SearchResult> {
  const t0 = Date.now();
  const a = opts.analysis ?? analyzeQuery(rawQuery);
  const filters: SearchFilters = { ...(opts.filters ?? {}) };
  const topK = opts.topK ?? 12;
  // Explicit release in the question => historical mode restricted to that release (never silently mixed).
  let mode: "latest" | "historical" = filters.mode === "historical" ? "historical" : "latest";
  if (filters.mode !== "latest" && a.releases.length && !filters.releases?.length) {
    filters.releases = a.releases;
    mode = "historical";
  }
  if (filters.releases?.length) mode = "historical";
  const channelCounts: Record<string, number> = {};
  const candidates: Candidate[] = [];
  const push = (rows: { id: string }[], channel: string) => {
    rows.forEach((r, i) => candidates.push({ id: r.id, rank: i + 1, channel }));
    channelCounts[channel] = rows.length;
  };

  const expansions = await loadExpansions(a, opts.workspaceIds);
  const ftsTerms = [...new Set([...a.keywords, ...expansions.flatMap((e) => e.expansion.toLowerCase().split(/\s+/))])]
    .map((t) => t.replace(/[^a-z0-9]/gi, ""))
    .filter((t) => t.length > 1)
    .slice(0, 40);

  // ---- channel 1: explicit clause lookup ----
  if (a.clauses.length && (a.specNumbers.length || filters.specNumbers?.length)) {
    const args: unknown[] = [opts.workspaceIds];
    const where = filterSql({ ...filters, specNumbers: filters.specNumbers?.length ? filters.specNumbers : a.specNumbers }, mode, args);
    args.push(a.clauses);
    const rows = await query<{ id: string }>(
      `SELECT c.id FROM document_chunks c WHERE ${where}
       AND EXISTS (SELECT 1 FROM unnest($${args.length}::text[]) cl WHERE c.clause = cl OR c.clause LIKE cl || '.%')
       ORDER BY (c.clause = ANY($${args.length})) DESC, length(c.clause), c.ord LIMIT 40`,
      args,
    );
    push(rows, "clause");
  }

  // ---- channel 2: exact identifier overlap ----
  if (a.strongIdentifiers.length) {
    const args: unknown[] = [opts.workspaceIds];
    const where = filterSql(filters, mode, args);
    args.push(a.strongIdentifiers);
    const p = `$${args.length}`;
    const rows = await query<{ id: string }>(
      `SELECT c.id FROM document_chunks c WHERE ${where} AND c.identifiers && ${p}
       ORDER BY (SELECT count(*) FROM unnest(c.identifiers) i WHERE i = ANY(${p})) DESC, c.authority_tier, c.token_count DESC LIMIT 60`,
      args,
    );
    push(rows, "ident");
  }

  // ---- channel 3: IDF-weighted full-text search ----
  // Postgres ts_rank has no inverse document frequency, so common words ("ue", "send") would swamp rare,
  // decisive ones ("widget", "T3540"). Estimate each term's document frequency (capped count), select
  // candidates using only selective terms, and score by the IDF-weighted sum of per-term ranks (BM25-like).
  if (ftsTerms.length) {
    const total = Math.max(1, (await query<{ n: number }>("SELECT GREATEST(reltuples, 1)::bigint AS n FROM pg_class WHERE relname = 'document_chunks'"))[0]?.n ?? 1);
    const CAP = 20000;
    const stats: { term: string; df: number; idf: number }[] = [];
    for (const term of ftsTerms.slice(0, 16)) {
      const r = await query<{ df: number }>(
        `SELECT count(*)::int AS df FROM (SELECT 1 FROM document_chunks c WHERE c.searchable AND c.workspace_id = ANY($1) AND c.fts @@ plainto_tsquery('english', $2) LIMIT ${CAP}) t`,
        [opts.workspaceIds, term],
      );
      const df = r[0]?.df ?? 0;
      if (df === 0) continue;
      stats.push({ term, df, idf: Math.log(1 + total / (df + 1)) });
    }
    if (stats.length) {
      stats.sort((x, y) => y.idf - x.idf);
      const selective = stats.filter((t) => t.df < Math.max(50, total * 0.08)).slice(0, 8);
      const args: unknown[] = [opts.workspaceIds];
      const where = filterSql(filters, mode, args);
      const terms = stats.slice(0, 12);
      const termParams = terms.map((t) => (args.push(t.term), `plainto_tsquery('english', $${args.length})`));
      const rankExpr = terms.map((t, i) => `${t.idf.toFixed(4)} * ts_rank_cd(c.fts, ${termParams[i]}, 32)`).join(" + ");
      // Candidate filter: any selective term; if every term is common, require all of them.
      const filterExpr = selective.length
        ? selective.map((t) => termParams[terms.indexOf(t)] ?? `plainto_tsquery('english', '${t.term.replace(/'/g, "")}')`).map((q) => `c.fts @@ ${q}`).join(" OR ")
        : termParams.map((q) => `c.fts @@ ${q}`).join(" AND ");
      const rows = await query<{ id: string }>(
        `SELECT c.id FROM document_chunks c WHERE ${where} AND (${filterExpr}) ORDER BY (${rankExpr}) DESC LIMIT 60`,
        args,
      );
      push(rows, "fts");
    } else channelCounts.fts = 0;
  }

  // ---- channel 4: vector similarity (only if the active model matches the configured provider) ----
  let vectorModel: string | null = null;
  try {
    const model = await activeEmbeddingModel();
    const provider = embeddingProvider();
    if (model && model.provider === provider.provider && model.model === provider.model && model.dimensions === provider.dimensions && model.version === provider.version) {
      vectorModel = `${model.provider}/${model.model}@${model.version} (${model.dimensions}d)`;
      const text = [a.normalized, ...expansions.map((e) => e.expansion)].join(" ");
      const [vec] = (await provider.embed([text])).vectors;
      const d = model.dimensions;
      const rows = await tx(async (client) => {
        await client.query("SET LOCAL hnsw.ef_search = 200");
        const args: unknown[] = [opts.workspaceIds];
        const where = filterSql(filters, mode, args);
        args.push(toVectorLiteral(vec!), model.id);
        return query<{ id: string }>(
          `SELECT c.id FROM embeddings e JOIN document_chunks c ON c.id = e.chunk_id
           WHERE e.model_id = $${args.length} AND ${where}
           ORDER BY e.embedding::vector(${d}) <=> $${args.length - 1}::vector(${d}) LIMIT 60`,
          args,
          client,
        );
      });
      push(rows, "vector");
    }
  } catch (err) {
    logger.warn("search.vector_failed", { error: errorMessage(err) });
  }

  // ---- fusion ----
  const fused = new Map<string, { score: number; channels: Set<string> }>();
  for (const c of candidates) {
    const f = fused.get(c.id) ?? { score: 0, channels: new Set<string>() };
    f.score += (CHANNEL_WEIGHTS[c.channel] ?? 1) / (RRF_K + c.rank);
    f.channels.add(c.channel);
    fused.set(c.id, f);
  }
  const ids = [...fused.keys()];
  const gaps: string[] = [];
  if (!ids.length) {
    const unknownTerms = await findUnknownTerms(a, opts.workspaceIds);
    await addSpecGaps(a, opts.workspaceIds, gaps, mode, filters);
    return { analysis: a, evidence: [], gaps, unknownTerms, channelCounts, expansions, mode, latencyMs: Date.now() - t0, vectorModel };
  }

  const rows = await query<Record<string, unknown>>(
    `SELECT c.id, c.document_id, c.version_id, c.section_id, c.ord, c.chunk_type, c.content, c.content_hash, c.clause, c.heading_path, c.page_start, c.page_end,
            c.symbol, c.language, c.line_start, c.line_end, c.identifiers, c.flags, c.spec_number, c.release, c.source_type, c.authority_tier, c.tags, c.is_current,
            d.title, d.spec_type, v.version_label, v.source_url, v.repo_path, v.commit_sha, v.license
     FROM document_chunks c JOIN documents d ON d.id = c.document_id JOIN document_versions v ON v.id = c.version_id
     WHERE c.id = ANY($1)`,
    [ids],
  );

  const keywordSet = new Set(a.keywords);
  const scored = rows.map((r) => {
    const f = fused.get(r.id as string)!;
    let s = f.score;
    const flags = r.flags as string[];
    const tier = r.authority_tier as number;
    s *= ({ 1: 1.15, 2: 1.08, 3: 1.0, 4: 0.92 } as Record<number, number>)[tier] ?? 1;
    if (flags.includes("boilerplate")) s *= 0.3;
    if (flags.includes("references")) s *= 0.6;
    if (flags.includes("ocr_low_confidence")) s *= 0.6;
    else if (flags.includes("ocr")) s *= 0.9;
    if (flags.includes("suspicious_instructions")) s *= 0.5;
    if (flags.includes("generated")) s *= 0.45;
    // "Where is X implemented/handled": executable source before schema definitions (ASN.1/protobuf).
    if (a.intents.includes("code") && (r.language === "asn1" || r.language === "protobuf")) s *= 0.8;
    const type = r.chunk_type as string;
    if (a.intents.includes("definition") && type === "definition") s *= 1.5;
    if (a.intents.includes("definition") && type === "abbreviation") s *= 1.2;
    if (type === "code" || type === "config") s *= a.intents.includes("code") ? 1.4 : 0.75;
    if (type.startsWith("api_")) s *= a.intents.includes("api") ? 1.4 : 0.9;
    if (a.intents.includes("requirement") && flags.includes("normative")) s *= 1.2;
    if (a.specNumbers.length && a.specNumbers.includes(r.spec_number as string)) s *= 1.6;
    const tags = r.tags as string[];
    if (a.generation === "lte" && tags.includes("5g") && !tags.includes("lte")) s *= 0.85;
    if (a.generation === "5g" && tags.includes("lte") && !tags.includes("5g")) s *= 0.85;
    // Heading match: the clause title contains query keywords (e.g. "General Registration").
    const heading = String(r.heading_path ?? "").toLowerCase().split(">").pop() ?? "";
    const hits = [...keywordSet].filter((k) => heading.includes(k)).length;
    if (hits) s *= 1 + Math.min(0.6, 0.2 * hits);
    return { r, s, channels: [...f.channels] };
  });
  scored.sort((x, y) => y.s - x.s);

  // ---- dedupe: identical text, and at most 3 chunks per section ----
  const seenHash = new Set<string>();
  const perSection = new Map<string, number>();
  const picked: typeof scored = [];
  for (const c of scored) {
    const h = c.r.content_hash as string;
    if (seenHash.has(h)) continue;
    const sec = (c.r.section_id as string) ?? (c.r.id as string);
    if ((perSection.get(sec) ?? 0) >= 3) continue;
    seenHash.add(h);
    perSection.set(sec, (perSection.get(sec) ?? 0) + 1);
    picked.push(c);
    if (picked.length >= topK) break;
  }

  // ---- parent expansion: neighbouring chunks in the same section ----
  const neighborRows = picked.length
    ? await query<{ version_id: string; ord: number; content: string; section_id: string | null }>(
        `SELECT c.version_id, c.ord, c.content, c.section_id FROM document_chunks c
         JOIN unnest($1::uuid[], $2::int[]) AS t(v, o) ON c.version_id = t.v AND c.ord IN (t.o - 1, t.o + 1)`,
        [picked.map((p) => p.r.version_id), picked.map((p) => p.r.ord)],
      )
    : [];
  const neighbor = new Map(neighborRows.map((n) => [`${n.version_id}:${n.ord}`, n]));
  const budget = opts.contextBudgetTokens ?? 9000;
  let used = 0;
  const evidence: Evidence[] = [];
  for (const p of picked) {
    const r = p.r;
    const tokens = Math.ceil(String(r.content).length / 4);
    if (evidence.length && used + tokens > budget) break;
    used += tokens;
    const before = neighbor.get(`${r.version_id}:${(r.ord as number) - 1}`);
    const after = neighbor.get(`${r.version_id}:${(r.ord as number) + 1}`);
    evidence.push({
      n: evidence.length + 1,
      chunkId: r.id as string,
      documentId: r.document_id as string,
      versionId: r.version_id as string,
      title: r.title as string,
      specNumber: (r.spec_number as string) ?? null,
      specType: (r.spec_type as string) ?? null,
      version: (r.version_label as string) ?? null,
      release: (r.release as number) ?? null,
      isCurrent: r.is_current as boolean,
      clause: (r.clause as string) ?? null,
      headingPath: (r.heading_path as string) ?? null,
      sectionId: (r.section_id as string) ?? null,
      pageStart: (r.page_start as number) ?? null,
      pageEnd: (r.page_end as number) ?? null,
      sourceType: r.source_type as string,
      authorityTier: r.authority_tier as number,
      sourceUrl: (r.source_url as string) ?? null,
      chunkType: r.chunk_type as string,
      content: r.content as string,
      contextBefore: before && before.section_id === r.section_id ? before.content.slice(-600) : null,
      contextAfter: after && after.section_id === r.section_id ? after.content.slice(0, 600) : null,
      score: Number(p.s.toFixed(5)),
      channels: p.channels,
      flags: r.flags as string[],
      identifiers: r.identifiers as string[],
      symbol: (r.symbol as string) ?? null,
      language: (r.language as string) ?? null,
      lineStart: (r.line_start as number) ?? null,
      lineEnd: (r.line_end as number) ?? null,
      repoPath: (r.repo_path as string) ?? null,
      commitSha: (r.commit_sha as string) ?? null,
      license: (r.license as string) ?? null,
      ord: r.ord as number,
    });
  }

  const unknownTerms = await findUnknownTerms(a, opts.workspaceIds);
  await addSpecGaps(a, opts.workspaceIds, gaps, mode, filters);
  if (evidence.length && !evidence.some((e) => e.authorityTier === 1)) gaps.push("No official 3GPP specification text was retrieved for this question; the evidence below is secondary (implementation, schema or user material).");
  return { analysis: a, evidence, gaps, unknownTerms, channelCounts, expansions, mode, latencyMs: Date.now() - t0, vectorModel };
}

async function addSpecGaps(a: QueryAnalysis, workspaceIds: string[], gaps: string[], mode: string, filters: SearchFilters) {
  for (const spec of a.specNumbers) {
    const rows = await query<{ release: number | null; version_label: string | null; is_current: boolean }>(
      `SELECT v.release, v.version_label, v.is_current FROM documents d JOIN document_versions v ON v.document_id = d.id
       WHERE d.spec_number = $1 AND d.workspace_id = ANY($2) AND v.status IN ('indexed','superseded') AND d.review_status = 'approved'`,
      [spec, workspaceIds],
    );
    if (!rows.length) gaps.push(`TS/TR ${spec} is not indexed in your knowledge base, so statements about it cannot be verified here.`);
    else if (mode === "historical" && filters.releases?.length && !rows.some((r) => r.release !== null && filters.releases!.includes(r.release))) {
      gaps.push(`${spec} is indexed only for release(s) ${[...new Set(rows.map((r) => r.release))].join(", ")}; no version for Rel-${filters.releases.join("/")} is available.`);
    }
  }
  if (a.clauses.length && !a.specNumbers.length && !filters.specNumbers?.length) gaps.push(`Clause ${a.clauses.join(", ")} was mentioned without a specification number; clause numbers are only meaningful within a specific spec.`);
}
