import "./load-env";
import { migrate } from "../src/lib/migrate";
import { closePool } from "../src/lib/db";
import { ensureCommonsWorkspace, seedSources } from "../src/lib/sources/registry";
import { ensureEmbeddingModel } from "../src/lib/embeddings";
import { seedEvaluationCases } from "../src/lib/eval/cases";

await migrate();
const ws = await ensureCommonsWorkspace();
const added = await seedSources(ws);
const modelId = await ensureEmbeddingModel();
const cases = await seedEvaluationCases();
console.log(`Commons workspace ${ws}; ${added} new source(s); embedding model #${modelId}; ${cases} evaluation case(s).`);
await closePool();
