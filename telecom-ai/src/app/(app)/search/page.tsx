"use client";

import { useState } from "react";
import { api } from "@/lib/client";
import { Badge, Card, ErrorNote, PageHeader, Spinner, Empty } from "@/components/ui";
import { EvidenceCard } from "@/components/Evidence";
import type { EvidenceItem } from "@/components/types";

/* eslint-disable @typescript-eslint/no-explicit-any */
export default function SearchPage() {
  const [q, setQ] = useState("");
  const [chunkType, setChunkType] = useState("");
  const [tier, setTier] = useState("");
  const [spec, setSpec] = useState("");
  const [res, setRes] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const filters: Record<string, unknown> = {};
      if (chunkType) filters.chunkTypes = [chunkType];
      if (tier) filters.maxTier = Number(tier);
      if (spec) filters.specNumbers = spec.split(/[,\s]+/).filter(Boolean);
      setRes(await api("/api/search", { body: { query: q, topK: 30, filters } }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <PageHeader title="Hybrid search" subtitle="Raw retrieval results with per-channel diagnostics: exact clause lookup, identifier match, full-text and vector similarity, fused with reciprocal rank fusion." />
      <Card>
        <form className="grid gap-2 md:grid-cols-[1fr_auto_auto_auto_auto]" onSubmit={(e) => { e.preventDefault(); run(); }}>
          <input className="input" placeholder="e.g. T3510, Nsmf_PDUSession_CreateSMContext, clause 5.15 of TS 23.501" value={q} onChange={(e) => setQ(e.target.value)} />
          <input className="input md:w-36" placeholder="Spec (23.501)" value={spec} onChange={(e) => setSpec(e.target.value)} />
          <select className="input md:w-40" value={chunkType} onChange={(e) => setChunkType(e.target.value)}>
            <option value="">All chunk types</option>
            {["text", "definition", "abbreviation", "table", "figure_ocr", "code", "config", "api_operation", "api_schema"].map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <select className="input md:w-40" value={tier} onChange={(e) => setTier(e.target.value)}>
            <option value="">All authority tiers</option>
            <option value="1">Official only</option>
            <option value="2">Official + schemas</option>
            <option value="3">Up to reference impl.</option>
          </select>
          <button className="btn btn-primary" disabled={!q.trim() || busy}>{busy ? <Spinner /> : "Search"}</button>
        </form>
      </Card>
      <ErrorNote error={error} />
      {res && (
        <div className="mt-4 space-y-3">
          <Card title="Query analysis">
            <div className="flex flex-wrap gap-1.5 text-xs">
              <Badge tone="blue">mode: {res.mode}</Badge>
              {res.analysis.intents.map((i: string) => <Badge key={i}>intent: {i}</Badge>)}
              {res.analysis.specNumbers.map((s: string) => <Badge key={s} tone="green">spec {s}</Badge>)}
              {res.analysis.clauses.map((s: string) => <Badge key={s} tone="green">clause {s}</Badge>)}
              {res.analysis.releases.map((s: number) => <Badge key={s} tone="blue">Rel-{s}</Badge>)}
              {res.analysis.strongIdentifiers.map((s: string) => <Badge key={s} tone="violet">{s}</Badge>)}
              {Object.entries(res.channelCounts).map(([k, v]) => <Badge key={k}>{k}: {String(v)}</Badge>)}
              <Badge>vector model: {res.vectorModel ?? "none"}</Badge>
              <Badge>{res.latencyMs} ms</Badge>
            </div>
            {res.expansions.length > 0 && <div className="muted mt-2 text-xs">Abbreviation expansions from indexed specs: {res.expansions.map((e: any) => `${e.abbr} = ${e.expansion}`).join("; ")}</div>}
            {res.gaps.length > 0 && <ul className="mt-2 list-disc pl-5 text-xs text-amber-700 dark:text-amber-300">{res.gaps.map((g: string, i: number) => <li key={i}>{g}</li>)}</ul>}
            {res.unknownTerms.length > 0 && <div className="mt-1 text-xs text-red-600">Terms not found anywhere in the corpus: {res.unknownTerms.join(", ")}</div>}
          </Card>
          {res.evidence.length ? res.evidence.map((e: EvidenceItem) => <EvidenceCard key={e.chunkId} e={e} />) : <Empty>No results.</Empty>}
        </div>
      )}
    </div>
  );
}
