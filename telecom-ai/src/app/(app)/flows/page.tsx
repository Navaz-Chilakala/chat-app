"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import { Badge, Card, ErrorNote, PageHeader, Spinner } from "@/components/ui";
import { FlowView } from "@/components/AnswerView";
import { EvidenceCard, CitationDrawer } from "@/components/Evidence";
import type { EvidenceItem, Flow } from "@/components/types";

/* eslint-disable @typescript-eslint/no-explicit-any */
export default function FlowsPage() {
  const [catalog, setCatalog] = useState<any[]>([]);
  const [q, setQ] = useState("");
  const [res, setRes] = useState<{ evidenceFlow: Flow | null; curatedFlow: Flow | null; evidence: EvidenceItem[]; gaps: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<EvidenceItem | null>(null);
  useEffect(() => {
    api<{ flows: any[] }>("/api/flows").then((r) => setCatalog(r.flows)).catch((e) => setError(e.message));
  }, []);
  const build = async (body: { query?: string; flowId?: string }) => {
    setBusy(true);
    setError(null);
    try {
      setRes(await api("/api/flows/build", { body }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <PageHeader title="Call Flow Explorer" subtitle="Sequence diagrams generated from retrieved specification text (numbered “X to Y: message” steps), or curated summaries verified step-by-step against the indexed clause. Unverified steps are labelled." />
      <ErrorNote error={error} />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Procedures">
          <form className="mb-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); build({ query: q }); }}>
            <input className="input" placeholder="e.g. N2 based handover" value={q} onChange={(e) => setQ(e.target.value)} />
            <button className="btn btn-primary" disabled={busy || !q.trim()}>Build</button>
          </form>
          <ul className="space-y-1.5">
            {catalog.map((f) => (
              <li key={f.id}>
                <button className="w-full rounded-lg border hairline p-2.5 text-left text-sm hover:border-brand-500" onClick={() => build({ flowId: f.id })}>
                  <div className="font-medium">{f.title}</div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    <Badge tone={f.generation === "5g" ? "blue" : "violet"}>{f.generation === "5g" ? "5GS" : "LTE/EPC"}</Badge>
                    <Badge>TS {f.spec} §{f.clause}</Badge>
                    {f.verification?.clauseIndexed ? <Badge tone="green">{f.verification.stepsFound}/{f.verification.stepsTotal} verified</Badge> : <Badge tone="red">spec not indexed</Badge>}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </Card>
        <div className="space-y-4 lg:col-span-2">
          {busy && <Spinner />}
          {res && (
            <>
              {res.gaps.length > 0 && <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">{res.gaps.join(" ")}</div>}
              {res.evidenceFlow ? (
                <Card title="Flow derived from the retrieved clause"><FlowView flow={res.evidenceFlow} evidence={res.evidence} onOpen={setDrawer} /></Card>
              ) : (
                <Card title="Flow derived from the retrieved clause"><div className="muted text-sm">No numbered stage-2 steps (“N. X to Y: message”) were found in the retrieved text. Index the defining specification (e.g. TS 23.502 / TS 23.401) to get evidence-derived diagrams.</div></Card>
              )}
              {res.curatedFlow && <Card title="Curated reference flow (verified against index)"><FlowView flow={res.curatedFlow} evidence={res.evidence} onOpen={setDrawer} /></Card>}
              <Card title="Retrieved evidence">
                <div className="space-y-2">{res.evidence.map((e) => <EvidenceCard key={e.chunkId} e={e} />)}</div>
              </Card>
            </>
          )}
        </div>
      </div>
      <CitationDrawer evidence={drawer} onClose={() => setDrawer(null)} />
    </div>
  );
}
