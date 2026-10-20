"use client";

import { useState } from "react";
import type { AnswerData, EvidenceItem, Statement } from "./types";
import { Badge, CopyButton } from "./ui";
import { CitationDrawer, EvidenceCard, citeLabel } from "./Evidence";
import { Mermaid } from "./Mermaid";
import { MarkdownTable } from "./MarkdownTable";
import { api } from "@/lib/client";

function Cites({ ns, evidence, onOpen }: { ns: number[]; evidence: EvidenceItem[]; onOpen: (e: EvidenceItem) => void }) {
  return (
    <>
      {ns.map((n) => {
        const e = evidence.find((x) => x.n === n);
        if (!e) return null;
        return (
          <button key={n} onClick={() => onOpen(e)} title={citeLabel(e)} className="ml-1 inline-flex items-center rounded bg-brand-50 px-1 font-mono text-[11px] font-semibold text-brand-700 hover:bg-brand-100 dark:bg-brand-700/20 dark:text-brand-100">
            [{n}] <span className="ml-1 hidden font-sans font-normal sm:inline">{citeLabel(e)}</span>
          </button>
        );
      })}
    </>
  );
}

function StatementList({ items, evidence, onOpen }: { items: Statement[]; evidence: EvidenceItem[]; onOpen: (e: EvidenceItem) => void }) {
  return (
    <ul className="space-y-2">
      {items.map((s, i) => (
        <li key={i} className={`text-sm leading-6 ${s.kind === "normative" ? "prose-quote border-emerald-500" : s.kind === "step" ? "font-mono text-[12.5px]" : "prose-quote"}`}>
          <span className="whitespace-pre-wrap">{s.kind === "step" || s.kind === "note" ? s.text : `“${s.text}”`}</span>
          <Cites ns={s.citations} evidence={evidence} onOpen={onOpen} />
        </li>
      ))}
    </ul>
  );
}

const STEP_STATUS: Record<string, { label: string; tone: string }> = {
  from_source_text: { label: "from source", tone: "green" },
  found_in_clause: { label: "verified in clause", tone: "green" },
  not_found_in_clause: { label: "not found in clause", tone: "amber" },
  spec_not_indexed: { label: "spec not indexed", tone: "red" },
};

export function FlowView({ flow, evidence, onOpen }: { flow: NonNullable<AnswerData["flow"]>; evidence: EvidenceItem[]; onOpen: (e: EvidenceItem) => void }) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-semibold">{flow.title}</span>
        {flow.spec && <Badge tone="green">TS {flow.spec}{flow.clause ? ` §${flow.clause}` : ""}{flow.version ? ` V${flow.version}` : ""}</Badge>}
        <Badge tone={flow.origin === "evidence" ? "green" : "amber"}>{flow.origin === "evidence" ? "derived from retrieved clause" : "curated summary"}</Badge>
        {flow.verification && <Badge tone={flow.verification.stepsFound === flow.verification.stepsTotal ? "green" : "amber"}>{flow.verification.stepsFound}/{flow.verification.stepsTotal} steps verified</Badge>}
      </div>
      <Mermaid chart={flow.mermaid} />
      <div className="overflow-x-auto rounded-lg border hairline">
        <table className="min-w-full text-left text-xs">
          <thead className="bg-slate-50 dark:bg-slate-800/60">
            <tr><th className="px-2 py-1.5">Step</th><th className="px-2 py-1.5">From → To</th><th className="px-2 py-1.5">Message</th><th className="px-2 py-1.5">Interface / protocol</th><th className="px-2 py-1.5">Evidence</th></tr>
          </thead>
          <tbody>
            {flow.steps.map((s, i) => (
              <tr key={i} className="border-t hairline align-top">
                <td className="px-2 py-1.5 font-mono">{s.label}</td>
                <td className="px-2 py-1.5 whitespace-nowrap">{s.from} → {s.to}</td>
                <td className="px-2 py-1.5">{s.message}{(s.optional || s.condition) && <div className="muted">{s.condition ?? "optional"}</div>}</td>
                <td className="px-2 py-1.5">{[s.interface, s.protocol].filter(Boolean).join(" · ") || "—"}</td>
                <td className="px-2 py-1.5">{s.status && <Badge tone={STEP_STATUS[s.status]?.tone}>{STEP_STATUS[s.status]?.label ?? s.status}</Badge>}{s.citation ? <Cites ns={[s.citation]} evidence={evidence} onOpen={onOpen} /> : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="muted list-disc space-y-0.5 pl-5 text-xs">{flow.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
    </div>
  );
}

export function AnswerView({ answer, messageId, question, onRerun }: { answer: AnswerData; messageId?: string; question?: string; onRerun?: () => void }) {
  const [drawer, setDrawer] = useState<EvidenceItem | null>(null);
  const [showEvidence, setShowEvidence] = useState(false);
  const [rated, setRated] = useState<number | null>(null);
  const ev = answer.evidence;
  const plain = [
    question ? `Q: ${question}` : "",
    ...answer.summary.map((s) => `- "${s.text}" ${s.citations.map((n) => `[${n}]`).join("")}`),
    "",
    "Sources:",
    ...ev.map((e) => `[${e.n}] ${citeLabel(e)} — ${e.title}`),
  ].join("\n");
  const statusTone = answer.status === "answered" ? "green" : answer.status === "partial" ? "amber" : "red";
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={statusTone}>{answer.status === "insufficient_evidence" ? "Insufficient evidence" : answer.status === "partial" ? "Partial evidence" : "Answered from evidence"}</Badge>
        <Badge tone={answer.confidence === "high" ? "green" : answer.confidence === "medium" ? "blue" : "amber"}>retrieval confidence: {answer.confidence}</Badge>
        <Badge>{ev.length} source passage{ev.length === 1 ? "" : "s"}</Badge>
        <div className="ml-auto flex gap-1.5">
          <CopyButton text={plain} label="Copy answer" />
          {onRerun && <button className="btn !px-2 !py-1 text-xs" onClick={onRerun}>Re-run</button>}
          {messageId && (
            <>
              <button aria-label="Helpful" className={`btn !px-2 !py-1 text-xs ${rated === 1 ? "!bg-emerald-100 dark:!bg-emerald-900" : ""}`} onClick={async () => { await api("/api/feedback", { body: { messageId, rating: 1 } }); setRated(1); }}>👍</button>
              <button aria-label="Not helpful" className={`btn !px-2 !py-1 text-xs ${rated === -1 ? "!bg-red-100 dark:!bg-red-900" : ""}`} onClick={async () => { await api("/api/feedback", { body: { messageId, rating: -1 } }); setRated(-1); }}>👎</button>
            </>
          )}
        </div>
      </div>

      {answer.gaps.length > 0 && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          <div className="font-semibold">Evidence gaps</div>
          <ul className="mt-1 list-disc pl-5">{answer.gaps.map((g, i) => <li key={i}>{g}</li>)}</ul>
        </div>
      )}
      {answer.conflicts.length > 0 && (
        <div className="rounded-lg border border-violet-300 bg-violet-50 px-3 py-2 text-sm text-violet-900 dark:border-violet-800 dark:bg-violet-950 dark:text-violet-200">
          <div className="font-semibold">Version / release differences</div>
          <ul className="mt-1 list-disc pl-5">{answer.conflicts.map((g, i) => <li key={i}>{g}</li>)}</ul>
        </div>
      )}

      {answer.summary.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-semibold">Direct answer (verbatim quotes)</h3>
          <StatementList items={answer.summary} evidence={ev} onOpen={setDrawer} />
        </div>
      )}

      {answer.compare && (
        <div>
          <h3 className="mb-2 text-sm font-semibold">Side-by-side evidence</h3>
          <div className="grid gap-3 md:grid-cols-2">
            {answer.compare.map((c) => (
              <div key={c.label} className="panel p-3">
                <div className="mb-2 text-sm font-semibold">{c.label}</div>
                {c.statements.length ? <StatementList items={c.statements} evidence={ev} onOpen={setDrawer} /> : <div className="muted text-sm">No evidence found for this side.</div>}
              </div>
            ))}
          </div>
        </div>
      )}

      {answer.flow && (
        <div>
          <h3 className="mb-2 text-sm font-semibold">End-to-end call flow</h3>
          <FlowView flow={answer.flow} evidence={ev} onOpen={setDrawer} />
        </div>
      )}

      {answer.apiOperations.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-semibold">API operations (from the indexed OpenAPI schema)</h3>
          <div className="space-y-2">
            {answer.apiOperations.map((o, i) => (
              <div key={i} className="panel p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="blue">{o.method}</Badge>
                  <code className="font-mono text-xs">{o.path}</code>
                  {o.operationId && <Badge>operationId: {o.operationId}</Badge>}
                  <Badge>{o.apiTitle}{o.apiVersion ? ` ${o.apiVersion}` : ""}</Badge>
                  <Cites ns={[o.citation]} evidence={ev} onOpen={setDrawer} />
                </div>
                {o.summary && <div className="mt-1">{o.summary}</div>}
                <div className="mt-2 grid gap-2 text-xs sm:grid-cols-2">
                  <div><span className="font-medium">Parameters:</span> {o.parameters.length ? o.parameters.map((p) => `${p.name} (${p.in}${p.required ? ", required" : ""}: ${p.type})`).join("; ") : "none"}</div>
                  <div><span className="font-medium">Request body:</span> {o.requestBody ?? "none"}</div>
                  <div><span className="font-medium">Responses:</span> {o.responses.map((r) => r.code).join(", ")}</div>
                  <div><span className="font-medium">Security:</span> {o.security ?? "not declared"}</div>
                </div>
                <div className="muted mt-2 text-xs">The schema describes message structure; procedure behaviour is defined in {o.specRefs.length ? o.specRefs.map((s) => `TS ${s}`).join(", ") : "the corresponding 3GPP stage-2/stage-3 specification"}.</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {answer.sections.map((sec) => (
        <div key={sec.id}>
          <h3 className="mb-2 text-sm font-semibold">{sec.title}</h3>
          {sec.statements && <StatementList items={sec.statements} evidence={ev} onOpen={setDrawer} />}
          {sec.table && (
            <div className="space-y-1">
              <MarkdownTable markdown={sec.table.markdown} />
              <div className="text-xs"><Cites ns={[sec.table.citation]} evidence={ev} onOpen={setDrawer} /></div>
            </div>
          )}
          {sec.items && (
            <ul className="grid gap-1.5 sm:grid-cols-2">
              {sec.items.map((it, i) => (
                <li key={i} className="rounded-md border hairline px-2.5 py-1.5 text-xs">
                  <span className="font-mono font-semibold">{it.label}</span> <span className="muted">— {it.detail}</span>
                  <Cites ns={it.citations.slice(0, 4)} evidence={ev} onOpen={setDrawer} />
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}

      <div>
        <button className="btn text-xs" onClick={() => setShowEvidence((s) => !s)}>{showEvidence ? "Hide" : "Show"} all {ev.length} retrieved passages</button>
        {showEvidence && <div className="mt-3 space-y-2">{ev.map((e) => <EvidenceCard key={e.n} e={e} />)}</div>}
      </div>
      <p className="muted text-xs">{answer.notice}</p>
      <CitationDrawer evidence={drawer} onClose={() => setDrawer(null)} />
    </div>
  );
}
