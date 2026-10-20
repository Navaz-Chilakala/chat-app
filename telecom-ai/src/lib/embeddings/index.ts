import { env } from "../env";
import { query, queryOne, type Queryable } from "../db";
import { LOCAL_HASH_VERSION, localHashEmbed } from "./local-hash";
import { logger } from "../logger";

export interface EmbeddingProvider {
  provider: string;
  model: string;
  dimensions: number;
  version: string;
  costPer1MTokens: number;
  embed(texts: string[]): Promise<{ vectors: number[][]; tokens: number }>;
}

class LocalHashProvider implements EmbeddingProvider {
  provider = "local-hash";
  model = "telecom-lexical-hash";
  version = LOCAL_HASH_VERSION;
  costPer1MTokens = 0;
  constructor(public dimensions: number) {}
  async embed(texts: string[]) {
    return { vectors: texts.map((t) => localHashEmbed(t, this.dimensions)), tokens: texts.reduce((n, t) => n + Math.ceil(t.length / 4), 0) };
  }
}

/** Any OpenAI-compatible /v1/embeddings endpoint (OpenAI, Azure OpenAI, TEI, vLLM, Ollama, LiteLLM...). */
class OpenAICompatibleProvider implements EmbeddingProvider {
  provider = "openai-compatible";
  version = "1";
  constructor(
    private url: string,
    private apiKey: string,
    public model: string,
    public dimensions: number,
    public costPer1MTokens: number,
  ) {}
  async embed(texts: string[]) {
    const endpoint = this.url.replace(/\/$/, "").endsWith("/embeddings") ? this.url : `${this.url.replace(/\/$/, "")}/embeddings`;
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
        body: JSON.stringify({ model: this.model, input: texts, dimensions: this.dimensions }),
        signal: AbortSignal.timeout(60_000),
      });
      if (res.ok) {
        const body = (await res.json()) as { data: { embedding: number[]; index: number }[]; usage?: { total_tokens?: number } };
        const vectors = body.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
        for (const v of vectors) if (v.length !== this.dimensions) throw new Error(`Embedding dimension mismatch: expected ${this.dimensions}, got ${v.length}`);
        return { vectors, tokens: body.usage?.total_tokens ?? texts.reduce((n, t) => n + Math.ceil(t.length / 4), 0) };
      }
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= 5) throw new Error(`Embedding request failed: HTTP ${res.status}`);
      const delay = Math.min(30_000, 1000 * 2 ** attempt) + Math.random() * 500;
      logger.warn("embeddings.retry", { status: res.status, attempt, delay });
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

let providerCache: EmbeddingProvider | null = null;

export function embeddingProvider(): EmbeddingProvider {
  if (providerCache) return providerCache;
  const e = env();
  if (e.EMBEDDING_PROVIDER === "openai-compatible") {
    if (!e.EMBEDDING_API_URL || !e.EMBEDDING_MODEL || !e.EMBEDDING_DIMENSIONS) {
      throw new Error("EMBEDDING_API_URL, EMBEDDING_MODEL and EMBEDDING_DIMENSIONS are required for openai-compatible embeddings");
    }
    providerCache = new OpenAICompatibleProvider(e.EMBEDDING_API_URL, e.EMBEDDING_API_KEY, e.EMBEDDING_MODEL, e.EMBEDDING_DIMENSIONS, e.EMBEDDING_COST_PER_1M_TOKENS);
  } else {
    providerCache = new LocalHashProvider(e.EMBEDDING_DIMENSIONS ?? 384);
  }
  return providerCache;
}

export function resetEmbeddingProvider() {
  providerCache = null;
}

/** Register the configured model (idempotent). The first registered model becomes active. */
export async function ensureEmbeddingModel(p: EmbeddingProvider = embeddingProvider(), client?: Queryable): Promise<number> {
  const row = await queryOne<{ id: number }>(
    `INSERT INTO embedding_models(provider, model, dimensions, version, is_active)
     VALUES ($1,$2,$3,$4, NOT EXISTS (SELECT 1 FROM embedding_models WHERE is_active))
     ON CONFLICT (provider, model, dimensions, version) DO UPDATE SET provider = EXCLUDED.provider
     RETURNING id`,
    [p.provider, p.model, p.dimensions, p.version],
    client,
  );
  const id = row!.id;
  await ensureVectorIndex(id, p.dimensions, client);
  return id;
}

/** Per-model partial HNSW index over the untyped vector column (cosine distance). */
export async function ensureVectorIndex(modelId: number, dims: number, client?: Queryable) {
  if (!Number.isInteger(modelId) || !Number.isInteger(dims) || dims > 2000) return; // HNSW supports <= 2000 dims
  await query(
    `CREATE INDEX IF NOT EXISTS embeddings_hnsw_m${modelId} ON embeddings
       USING hnsw ((embedding::vector(${dims})) vector_cosine_ops) WHERE model_id = ${modelId}`,
    [],
    client,
  );
}

export async function activeEmbeddingModel(): Promise<{ id: number; dimensions: number; provider: string; model: string; version: string } | null> {
  return queryOne(`SELECT id, dimensions, provider, model, version FROM embedding_models WHERE is_active`);
}

export function toVectorLiteral(v: number[]): string {
  return `[${v.map((x) => (Number.isFinite(x) ? x.toFixed(6) : "0")).join(",")}]`;
}
