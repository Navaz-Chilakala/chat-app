// Run the retrieval/answer evaluation suite against the indexed corpus: npm run eval
import "./load-env";
import { closePool, query } from "../src/lib/db";
import { seedEvaluationCases } from "../src/lib/eval/cases";
import { runEvaluation } from "../src/lib/eval/run";

await seedEvaluationCases();
const ws = (await query<{ id: string }>("SELECT id FROM workspaces WHERE kind = 'shared'")).map((r) => r.id);
const { metrics, results } = await runEvaluation(ws);
for (const r of results) console.log(`${r.status.padEnd(7)} ${r.name.padEnd(28)} rank=${r.rank ?? "-"} ${r.reason ?? ""}`);
console.log(JSON.stringify(metrics, null, 2));
await closePool();
