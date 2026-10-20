"use client";

import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { api, fmtBytes, fmtDate } from "@/lib/client";
import { Badge, Card, ErrorNote, PageHeader, SOURCE_TYPE_LABEL, StatusBadge, TIER_LABEL, Spinner } from "@/components/ui";
import { CodeBlock } from "@/components/CodeBlock";
import { MarkdownTable } from "@/components/MarkdownTable";

/* eslint-disable @typescript-eslint/no-explicit-any */
export default function DocumentPage() {
  const { id } = useParams<{ id: string }>();
  const sp = useSearchParams();
  const router = useRouter();
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [chunk, setChunk] = useState<any>(null);
  const [sectionChunks, setSectionChunks] = useState<any[] | null>(null);
  const version = sp.get("version");
  const chunkId = sp.get("chunk");

  useEffect(() => {
    api(`/api/documents/${id}${version ? `?version=${version}` : ""}`).then(setData).catch((e) => setError(e.message));
  }, [id, version]);
  useEffect(() => {
    if (!chunkId) return;
    api<{ chunk: any; siblings: any[] }>(`/api/chunks/${chunkId}`).then((r) => { setChunk(r.chunk); setSectionChunks(r.siblings); }).catch((e) => setError(e.message));
  }, [chunkId]);

  if (error) return <ErrorNote error={error} />;
  if (!data) return <Spinner />;
  const d = data.document;
  const current = data.versions.find((v: any) => v.id === data.versionId) ?? data.versions[0];
  const loadSection = async (sectionId: string) => {
    try {
      const r = await api<{ chunkId: string }>(`/api/documents/${id}/sections/${sectionId}`);
      router.push(`/documents/${id}?version=${data.versionId}&chunk=${r.chunkId}`);
    } catch (e) {
      window.alert((e as Error).message);
    }
  };
  return (
    <div>
      <PageHeader
        title={d.title}
        subtitle={d.doc_key}
        actions={
          <div className="flex flex-wrap gap-2">
            <a className="btn" href={`/api/documents/${id}/original?version=${data.versionId}`}>Download original</a>
            {d.review_status === "pending" && (
              <>
                <button className="btn" onClick={async () => { await api(`/api/documents/${id}/review`, { body: { status: "approved" } }); location.reload(); }}>Approve</button>
                <button className="btn btn-danger" onClick={async () => { await api(`/api/documents/${id}/review`, { body: { status: "rejected" } }); location.reload(); }}>Reject</button>
              </>
            )}
            <button className="btn btn-danger" onClick={async () => { if (confirm("Delete this document, all versions, chunks and embeddings?")) { await api(`/api/documents/${id}`, { method: "DELETE" }); router.push("/knowledge"); } }}>Delete</button>
          </div>
        }
      />
      <div className="mb-4 flex flex-wrap gap-1.5">
        <Badge tone={TIER_LABEL[d.authority_tier]?.tone}>{TIER_LABEL[d.authority_tier]?.label}</Badge>
        <Badge>{SOURCE_TYPE_LABEL[d.source_type] ?? d.source_type}</Badge>
        {d.spec_number && <Badge tone="green">{d.spec_type ?? "TS"} {d.spec_number}</Badge>}
        <StatusBadge status={d.review_status} />
        {(d.tags ?? []).map((t: string) => <Badge key={t} tone="blue">{t}</Badge>)}
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          {chunk && (
            <Card title={`Cited passage — ${chunk.heading_path ?? ""}`}>
              <div className="mb-2 flex flex-wrap gap-1.5">
                {chunk.clause && <Badge tone="green">§{chunk.clause}</Badge>}
                {chunk.page_start && <Badge>p. {chunk.page_start}</Badge>}
                {chunk.version_label && <Badge>V{chunk.version_label}</Badge>}
                {!chunk.is_current && <Badge tone="amber">historical version</Badge>}
                {(chunk.flags ?? []).map((f: string) => <Badge key={f} tone="violet">{f}</Badge>)}
              </div>
              <div className="space-y-2">
                {(sectionChunks ?? [chunk]).map((c: any) => (
                  <div key={c.id} className={`rounded-lg border p-3 text-sm ${c.id === chunk.id ? "border-brand-500 bg-brand-50/40 dark:bg-brand-700/10" : "hairline"}`}>
                    {chunk.language && (c.chunk_type === "code" || c.chunk_type === "config") ? <CodeBlock code={c.content} language={chunk.language} /> : c.chunk_type === "table" ? <MarkdownTable markdown={c.content} /> : <div className="whitespace-pre-wrap leading-6">{c.content}</div>}
                  </div>
                ))}
              </div>
            </Card>
          )}
          <Card title={`Sections (${data.sections.length})`}>
            {data.sections.length ? (
              <ul className="max-h-[560px] space-y-0.5 overflow-y-auto text-sm">
                {data.sections.map((s: any) => (
                  <li key={s.id} style={{ paddingLeft: `${Math.min(s.level, 8) * 12}px` }}>
                    <button className="w-full truncate rounded px-1.5 py-0.5 text-left hover:bg-slate-100 dark:hover:bg-slate-800" onClick={() => loadSection(s.id)}>
                      {s.clause && <span className="mr-1.5 font-mono text-xs text-brand-600">{s.clause}</span>}{s.heading}
                      {s.page_start && <span className="muted ml-1 text-xs">p.{s.page_start}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            ) : <div className="muted text-sm">No section structure (code, API or unstructured document).</div>}
          </Card>
        </div>
        <div className="space-y-4">
          <Card title="Version history">
            <ul className="space-y-3 text-sm">
              {data.versions.map((v: any) => (
                <li key={v.id} className={`rounded-lg border p-2.5 ${v.id === data.versionId ? "border-brand-500" : "hairline"}`}>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <button className="font-medium underline" onClick={() => router.push(`/documents/${id}?version=${v.id}`)}>{v.version_label ?? v.original_filename}</button>
                    {v.release && <Badge tone="blue">Rel-{v.release}</Badge>}
                    <StatusBadge status={v.status} />
                    {v.is_current && <Badge tone="green">current</Badge>}
                  </div>
                  <div className="muted mt-1 space-y-0.5 text-xs">
                    <div>{v.original_filename} · {fmtBytes(v.byte_size)} · {v.chunk_count} chunks{v.page_count ? ` · ${v.page_count} pages` : ""}</div>
                    <div>sha256 {v.checksum.slice(0, 16)}… · retrieved {fmtDate(v.retrieved_at)}</div>
                    {v.published_at && <div>published {String(v.published_at).slice(0, 7)}</div>}
                    {v.commit_sha && <div>commit {v.commit_sha.slice(0, 12)} · {v.repo_path}</div>}
                    {v.license && <div>license: {v.license}</div>}
                    {v.source_url && <div className="truncate">source: <a className="underline" href={v.source_url} target="_blank" rel="noopener noreferrer nofollow">{v.source_url}</a></div>}
                    {v.chunking_strategy && <div>chunking: {v.chunking_strategy} ({v.chunker_version})</div>}
                  </div>
                  {v.warnings?.length > 0 && (
                    <details className="mt-1.5 text-xs">
                      <summary className="cursor-pointer text-amber-700 dark:text-amber-300">{v.warnings.length} warning(s)</summary>
                      <ul className="mt-1 list-disc space-y-0.5 pl-4">{v.warnings.map((w: string, i: number) => <li key={i}>{w}</li>)}</ul>
                    </details>
                  )}
                </li>
              ))}
            </ul>
          </Card>
          <Card title="Provenance">
            <dl className="space-y-1 text-xs">
              <div><dt className="inline font-semibold">Source: </dt><dd className="inline">{d.source_name ?? "direct upload"}</dd></div>
              {d.source_url && <div><dt className="inline font-semibold">Registry URL: </dt><dd className="inline break-all">{d.source_url}</dd></div>}
              {d.source_license && <div><dt className="inline font-semibold">License: </dt><dd className="inline">{d.source_license}</dd></div>}
              <div><dt className="inline font-semibold">Created: </dt><dd className="inline">{fmtDate(d.created_at)}</dd></div>
            </dl>
          </Card>
          <Card title="Ingestion jobs">
            <ul className="space-y-1.5 text-xs">{data.jobs.map((j: any) => <li key={j.id} className="flex justify-between gap-2"><span>{j.kind} · {fmtDate(j.created_at)}</span><StatusBadge status={j.status} /></li>)}</ul>
          </Card>
        </div>
      </div>
    </div>
  );
}
