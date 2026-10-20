import { query } from "../db";
import type { Evidence } from "../retrieval/search";
import type { FlowResult, FlowStep } from "./types";
import { matchCuratedFlow } from "./catalog";

const STEP_RE = /^(\d{1,2}[a-z]?)\.\s+(.+)$/;
// "1. UE to (R)AN: AN message (...)" / "4. new AMF to old AMF: Namf_..." (3GPP stage-2 convention)
const ARROW_RE = /^(?:\[[^\]]+\]\s*)?(.{1,40}?)\s+(?:to|→|->)\s+(.{1,40}?)\s*:\s*(.+)$/;

export function sanitizeParticipant(name: string): string {
  return name.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 30) || "X";
}

function label(text: string, max = 90): string {
  const t = text.replace(/[;#:]/g, ",").replace(/[<>]/g, "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export function renderMermaid(steps: FlowStep[], participants?: string[]): string {
  const order = participants?.length ? [...participants] : [];
  for (const s of steps) for (const p of [s.from, s.to]) if (!order.includes(p)) order.push(p);
  const lines = ["sequenceDiagram", "  autonumber"];
  for (const p of order) lines.push(`  participant ${sanitizeParticipant(p)} as ${label(p, 40)}`);
  for (const s of steps) {
    const msg = label(`${s.message}${s.interface ? ` [${s.interface}]` : ""}`);
    const arrow = `  ${sanitizeParticipant(s.from)}->>${sanitizeParticipant(s.to)}: ${msg}`;
    if (s.optional || s.condition) {
      lines.push(`  opt ${label(s.condition ?? "conditional", 60)}`, `  ${arrow}`, "  end");
    } else lines.push(arrow);
    if (s.status === "not_found_in_clause") lines.push(`  Note over ${sanitizeParticipant(s.from)}: unverified in indexed clause`);
  }
  return lines.join("\n");
}

/** Extract an evidence-derived flow from numbered "X to Y: message" steps in the retrieved procedure clause. */
export async function flowFromEvidence(evidence: Evidence[]): Promise<FlowResult | null> {
  // Pick the best-ranked normative chunk whose text contains stage-2 style numbered steps.
  const seed = evidence.find((e) => e.authorityTier <= 2 && e.content.split("\n").filter((l) => STEP_RE.test(l.trim()) && ARROW_RE.test(l.trim().replace(STEP_RE, "$2"))).length >= 1);
  if (!seed || !seed.sectionId) return null;
  // Expand to the whole clause (all chunks of the section, in order) — parent-section expansion.
  const rows = await query<{ content: string; ord: number }>("SELECT content, ord FROM document_chunks WHERE version_id = $1 AND section_id = $2 ORDER BY ord", [seed.versionId, seed.sectionId]);
  const steps: FlowStep[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    for (const raw of r.content.split("\n")) {
      const line = raw.trim();
      const s = STEP_RE.exec(line);
      if (!s) continue;
      const a = ARROW_RE.exec(s[2]!);
      if (!a) continue;
      const key = `${s[1]}|${a[1]}|${a[2]}`;
      if (seen.has(key)) continue; // chunk overlap
      seen.add(key);
      const message = a[3]!.replace(/\.$/, "");
      const conditional = /^\[?(conditional|optional)\]?/i.test(line) || /\b(optional|conditional)\b/i.test(s[2]!.slice(0, 40));
      steps.push({
        label: s[1]!,
        from: a[1]!.replace(/^\[[^\]]+\]\s*/, "").trim(),
        to: a[2]!.trim(),
        message: message.length > 160 ? `${message.slice(0, 157)}…` : message,
        optional: conditional,
        condition: conditional ? "conditional (see source step)" : undefined,
        status: "from_source_text",
        citation: seed.n,
        sourceText: line.slice(0, 400),
      });
    }
  }
  if (steps.length < 2) return null;
  return {
    title: seed.headingPath?.split(" > ").pop() ?? "Procedure",
    origin: "evidence",
    spec: seed.specNumber,
    clause: seed.clause,
    version: seed.version,
    steps,
    mermaid: renderMermaid(steps),
    notes: [
      "Diagram generated directly from the numbered steps in the cited clause (no paraphrasing of message names).",
      "Step text is truncated for the diagram; read the full step in the cited source, including conditions.",
    ],
    verification: { clauseIndexed: true, stepsFound: steps.length, stepsTotal: steps.length },
  };
}

/** Curated flow verified against the indexed clause text. */
export async function curatedFlow(q: string, generation: "lte" | "5g" | "both" | null, workspaceIds: string[]): Promise<FlowResult | null> {
  const flow = matchCuratedFlow(q, generation);
  if (!flow) return null;
  const rows = await query<{ content: string; version_label: string | null; clause: string }>(
    `SELECT c.content, v.version_label, c.clause FROM document_chunks c JOIN document_versions v ON v.id = c.version_id
     WHERE c.spec_number = $1 AND (c.clause = $2 OR c.clause LIKE $2 || '.%') AND c.searchable AND c.is_current AND c.workspace_id = ANY($3)
     ORDER BY c.ord`,
    [flow.spec, flow.clause, workspaceIds],
  );
  const clauseText = rows.map((r) => r.content).join("\n").toLowerCase().replace(/\s+/g, " ");
  const indexed = rows.length > 0;
  const steps: FlowStep[] = flow.steps.map((s, i) => {
    const found = indexed && (s.match ?? [s.message]).some((m) => clauseText.includes(m.toLowerCase()));
    return { ...s, label: String(i + 1), status: !indexed ? "spec_not_indexed" : found ? "found_in_clause" : "not_found_in_clause", citation: null };
  });
  const foundCount = steps.filter((s) => s.status === "found_in_clause").length;
  return {
    title: flow.title,
    origin: "curated",
    spec: flow.spec,
    clause: flow.clause,
    version: rows[0]?.version_label ?? null,
    steps,
    mermaid: renderMermaid(steps, flow.participants),
    notes: [
      "Curated engineering summary — not normative text. Read the cited clause for the authoritative step list, conditions and parameters.",
      indexed
        ? `${foundCount}/${steps.length} step message names were found in the indexed text of TS ${flow.spec} clause ${flow.clause}.`
        : `TS ${flow.spec} clause ${flow.clause} is not indexed, so none of these steps could be verified.`,
    ],
    verification: { clauseIndexed: indexed, stepsFound: foundCount, stepsTotal: steps.length },
  };
}
