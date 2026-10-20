"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api, fmtBytes, fmtDate } from "@/lib/client";
import { Badge, Card, Empty, ErrorNote, PageHeader, SOURCE_TYPE_LABEL, Stat, StatusBadge, TIER_LABEL } from "@/components/ui";

/* eslint-disable @typescript-eslint/no-explicit-any */
export default function KnowledgePage() {
  const [stats, setStats] = useState<any>(null);
  const [docs, setDocs] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [q, setQ] = useState("");
  const [error, setError] = useState<string | null>(null);
  const load = () => {
    api("/api/stats").then(setStats).catch((e) => setError(e.message));
    api<{ documents: any[]; total: number }>(`/api/documents?limit=100${q ? `&q=${encodeURIComponent(q)}` : ""}`).then((r) => { setDocs(r.documents); setTotal(r.total); }).catch((e) => setError(e.message));
  };
  useEffect(() => {
    load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const t = stats?.totals;
  const queue = Object.fromEntries((stats?.queue ?? []).map((r: any) => [r.status, r.n]));
  return (
    <div>
      <PageHeader title="Knowledge Base" subtitle="Live statistics from the database: documents, versions, chunks, embeddings, ingestion queue and index health." actions={<button className="btn" onClick={load}>Refresh</button>} />
      <ErrorNote error={error} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="Documents" value={t?.documents ?? "—"} hint={`${t?.specs ?? 0} distinct 3GPP specs`} />
        <Stat label="Indexed versions" value={t?.indexed_versions ?? "—"} />
        <Stat label="Chunks" value={t?.chunks ?? "—"} hint={`${t?.searchable_chunks ?? 0} searchable`} />
        <Stat label="Embeddings" value={t?.embeddings ?? "—"} />
        <Stat label="Queue" value={`${queue.queued ?? 0} / ${queue.running ?? 0}`} hint="queued / running" />
        <Stat label="Failed jobs" value={queue.failed ?? 0} />
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card title="Sources by authority">
          {stats?.byAuthority?.length ? (
            <ul className="space-y-1.5 text-sm">
              {stats.byAuthority.map((r: any, i: number) => (
                <li key={i} className="flex items-center justify-between gap-2">
                  <span className="flex flex-wrap items-center gap-1.5"><Badge tone={TIER_LABEL[r.authority_tier]?.tone}>Tier {r.authority_tier}</Badge>{SOURCE_TYPE_LABEL[r.source_type] ?? r.source_type}</span>
                  <span className="tabular-nums">{r.n}</span>
                </li>
              ))}
            </ul>
          ) : <Empty>No documents yet.</Empty>}
        </Card>
        <Card title="Index health">
          <ul className="space-y-1.5 text-sm">
            <li className="flex justify-between"><span>Searchable chunks without active-model vector</span><span className="tabular-nums">{stats?.indexHealth?.searchable_without_vector ?? "—"}</span></li>
            <li className="flex justify-between"><span>Failed versions</span><span className="tabular-nums">{stats?.indexHealth?.failed_versions ?? "—"}</span></li>
            <li className="flex justify-between"><span>Pending / processing versions</span><span className="tabular-nums">{stats?.indexHealth?.pending_versions ?? "—"}</span></li>
            <li className="flex justify-between"><span>OCR chunks (low confidence)</span><span className="tabular-nums">{stats?.ocr?.ocr_chunks ?? 0} ({stats?.ocr?.low_confidence ?? 0})</span></li>
            {stats?.models?.map((m: any) => (
              <li key={m.id} className="flex justify-between"><span>Model {m.provider}/{m.model} {m.dimensions}d {m.is_active && <Badge tone="green">active</Badge>}</span><span className="tabular-nums">{m.vectors}</span></li>
            ))}
          </ul>
        </Card>
        <Card title="Storage & embedding cost">
          <ul className="space-y-1.5 text-sm">
            <li className="flex justify-between"><span>Original documents (total size)</span><span>{fmtBytes(stats?.storage?.original_bytes)}</span></li>
            <li className="flex justify-between"><span>Originals stored by this app</span><span>{fmtBytes(stats?.storage?.stored_bytes)}</span></li>
            <li className="flex justify-between"><span>Database size</span><span>{fmtBytes(stats?.storage?.database_bytes)}</span></li>
            <li className="flex justify-between"><span>Embedded texts / cache hits</span><span className="tabular-nums">{stats?.cost?.texts ?? 0} / {stats?.cost?.cache_hits ?? 0}</span></li>
            <li className="flex justify-between"><span>Estimated embedding cost</span><span>${(stats?.cost?.cost_usd ?? 0).toFixed(4)}</span></li>
          </ul>
        </Card>
        <Card title="Last synchronisation">
          {stats?.sync?.length ? (
            <ul className="space-y-1.5 text-sm">{stats.sync.map((s: any, i: number) => <li key={i} className="flex justify-between gap-2"><span className="truncate">{s.name}</span><span className="muted shrink-0 text-xs">{fmtDate(s.last_synced_at)}</span></li>)}</ul>
          ) : <Empty>No sources.</Empty>}
        </Card>
        <Card title="Failed jobs" actions={<Link className="text-xs text-brand-600 underline" href="/jobs?status=failed">All</Link>}>
          {stats?.failed?.length ? (
            <ul className="space-y-1.5 text-sm">{stats.failed.map((f: any) => <li key={f.id}><div className="truncate font-medium">{f.title ?? f.kind}</div><div className="muted truncate text-xs">{f.error}</div></li>)}</ul>
          ) : <Empty>No failed jobs.</Empty>}
        </Card>
        <Card title="Awaiting review">
          {stats?.review?.length ? (
            <ul className="space-y-1.5 text-sm">{stats.review.map((d: any) => <li key={d.id}><Link className="underline" href={`/documents/${d.id}`}>{d.title}</Link></li>)}</ul>
          ) : <Empty>Nothing awaiting review.</Empty>}
        </Card>
      </div>
      <Card className="mt-4" title={`Documents (${total})`} actions={
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); load(); }}>
          <input className="input !w-56" placeholder="Title or spec number" value={q} onChange={(e) => setQ(e.target.value)} />
          <button className="btn">Filter</button>
        </form>
      }>
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="muted text-xs"><tr><th className="py-2 pr-3">Title</th><th className="pr-3">Spec</th><th className="pr-3">Version</th><th className="pr-3">Authority</th><th className="pr-3">Status</th><th className="pr-3">Chunks</th><th>Updated</th></tr></thead>
            <tbody>
              {docs.map((d) => (
                <tr key={d.id} className="border-t hairline">
                  <td className="max-w-[380px] py-2 pr-3"><Link className="font-medium hover:underline" href={`/documents/${d.id}`}>{d.title}</Link>{d.review_status !== "approved" && <span className="ml-1"><StatusBadge status={d.review_status} /></span>}</td>
                  <td className="pr-3 font-mono text-xs">{d.spec_number ?? "—"}</td>
                  <td className="pr-3 text-xs">{d.version_label ?? "—"}{d.release ? ` (Rel-${d.release})` : ""}</td>
                  <td className="pr-3"><Badge tone={TIER_LABEL[d.authority_tier]?.tone}>Tier {d.authority_tier}</Badge></td>
                  <td className="pr-3"><StatusBadge status={d.status ?? d.latest_status} /></td>
                  <td className="pr-3 tabular-nums">{d.chunk_count ?? 0}</td>
                  <td className="muted text-xs">{fmtDate(d.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!docs.length && <Empty>No documents. <Link className="underline" href="/upload">Upload</Link> or sync a source.</Empty>}
        </div>
      </Card>
    </div>
  );
}
