"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import { Badge, Card, ErrorNote, PageHeader } from "@/components/ui";

/* eslint-disable @typescript-eslint/no-explicit-any */
export default function SettingsPage() {
  const [data, setData] = useState<any>(null);
  const [me, setMe] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const load = () => {
    api("/api/settings/embeddings").then(setData).catch((e) => setError(e.message));
    api("/api/auth/me").then(setMe);
  };
  useEffect(load, []);
  return (
    <div>
      <PageHeader title="Settings" subtitle="Retrieval configuration, embedding models, OCR and your workspaces." />
      <ErrorNote error={error} />
      {msg && <div className="mb-3 text-sm text-emerald-700 dark:text-emerald-300">{msg}</div>}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Answering">
          <p className="text-sm">Generation: <Badge tone="green">{data?.llm ?? "none"}</Badge></p>
          <p className="muted mt-2 text-xs">Answers are composed only from verbatim passages of indexed documents with citations. No language model generates text, so nothing can be invented; when evidence is missing the system says so.</p>
        </Card>
        <Card title="OCR">
          {data?.ocr && (
            <ul className="space-y-1 text-sm">
              <li>Enabled: <Badge tone={data.ocr.enabled ? "green" : "red"}>{String(data.ocr.enabled)}</Badge></li>
              <li>Figure OCR: <Badge tone={data.ocr.figures ? "green" : "gray"}>{String(data.ocr.figures)}</Badge></li>
              <li>Model: Tesseract LSTM “{data.ocr.model}” (English)</li>
              <li>Low-confidence threshold: {data.ocr.minConfidence}% (below → flagged and down-ranked)</li>
            </ul>
          )}
          <p className="muted mt-2 text-xs">Configured with OCR_ENABLED, OCR_FIGURES, OCR_MODEL and OCR_MIN_CONFIDENCE on the worker.</p>
        </Card>
        <Card className="lg:col-span-2" title="Embedding models">
          {data && (
            <>
              <p className="text-sm">Configured provider: <code>{data.configured.provider}/{data.configured.model}</code> · {data.configured.dimensions} dims · version {data.configured.version}</p>
              <table className="mt-3 min-w-full text-left text-sm">
                <thead className="muted text-xs"><tr><th className="py-1.5 pr-3">Model</th><th className="pr-3">Dims</th><th className="pr-3">Coverage</th><th className="pr-3">Status</th><th /></tr></thead>
                <tbody>
                  {data.models.map((m: any) => (
                    <tr key={m.id} className="border-t hairline">
                      <td className="py-1.5 pr-3 font-mono text-xs">{m.provider}/{m.model}@{m.version}</td>
                      <td className="pr-3">{m.dimensions}</td>
                      <td className="pr-3 tabular-nums">{m.vectors}/{m.chunks}</td>
                      <td className="pr-3">{m.is_active ? <Badge tone="green">active</Badge> : <Badge>inactive</Badge>}</td>
                      <td>{me?.user?.isAdmin && !m.is_active && <button className="btn !py-1 text-xs" onClick={async () => { try { await api("/api/settings/embeddings", { body: { action: "activate", modelId: m.id } }); setMsg("Model activated"); load(); } catch (e) { setError((e as Error).message); } }}>Activate</button>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {me?.user?.isAdmin && <button className="btn mt-3" onClick={async () => { const r = await api<{ jobId: string }>("/api/settings/embeddings", { body: { action: "reembed" } }); setMsg(`Re-embedding job ${r.jobId} queued for the configured model. The active index is untouched until you activate the new model.`); }}>Re-embed corpus with configured model</button>}
              <p className="muted mt-2 text-xs">The default local-hash model is a lexical feature-hashing embedding computed offline (no external API). Set EMBEDDING_PROVIDER=openai-compatible to use a neural embedding endpoint; vectors for each model are stored separately so a switch never corrupts the existing index.</p>
            </>
          )}
        </Card>
        <Card title="Your workspaces">
          <ul className="space-y-1 text-sm">{(me?.workspaces ?? []).map((w: any) => <li key={w.id} className="flex justify-between"><span>{w.name}</span><span className="flex gap-1"><Badge>{w.kind}</Badge><Badge tone="blue">{w.role}</Badge></span></li>)}</ul>
        </Card>
      </div>
    </div>
  );
}
