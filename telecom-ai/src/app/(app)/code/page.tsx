"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import { Badge, Card, ErrorNote, PageHeader, Empty, StatusBadge } from "@/components/ui";
import { CodeBlock } from "@/components/CodeBlock";

/* eslint-disable @typescript-eslint/no-explicit-any */
export default function CodePage() {
  const [q, setQ] = useState("");
  const [symbols, setSymbols] = useState<any[]>([]);
  const [repos, setRepos] = useState<any[]>([]);
  const [chunk, setChunk] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => api<{ symbols: any[]; repos: any[] }>(`/api/code/symbols?q=${encodeURIComponent(q)}`).then((r) => { setSymbols(r.symbols); setRepos(r.repos); }).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div>
      <PageHeader title="Code Explorer" subtitle="Symbol-aware index of approved repositories (functions, classes, ASN.1 definitions, protocol handlers). Every result records repository, commit, path, lines and licence. Code is never executed." />
      <ErrorNote error={error} />
      <Card title="Repositories">
        {repos.length ? (
          <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
            {repos.map((r) => (
              <div key={r.id} className="rounded-lg border hairline p-2.5 text-sm">
                <div className="flex items-center justify-between gap-2"><span className="font-medium">{r.name}</span><StatusBadge status={r.status} /></div>
                <div className="muted text-xs">{r.license ?? "licence unknown"} · {r.files} files{r.commit_sha ? ` · @${r.commit_sha.slice(0, 10)}` : " · not synced"}</div>
              </div>
            ))}
          </div>
        ) : <Empty>No repositories registered.</Empty>}
        <div className="muted mt-2 text-xs">Activate and sync repositories from <Link className="underline" href="/sources">Sources</Link> (requires the container worker with git).</div>
      </Card>
      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <Card title="Symbols">
          <form className="mb-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); load(); }}>
            <input className="input" placeholder="e.g. ngap_handle_initial_ue_message, InitialUEMessage, amf_nsmf" value={q} onChange={(e) => setQ(e.target.value)} />
            <button className="btn btn-primary">Find</button>
          </form>
          {symbols.length ? (
            <ul className="max-h-[600px] space-y-1 overflow-y-auto text-sm">
              {symbols.map((s) => (
                <li key={s.id}>
                  <button className="w-full rounded-md border hairline px-2.5 py-1.5 text-left hover:border-brand-500" onClick={async () => setChunk((await api<{ chunk: any }>(`/api/chunks/${s.chunk_id}`)).chunk)}>
                    <div className="flex flex-wrap items-center gap-1.5"><code className="font-semibold">{s.name}</code><Badge>{s.kind}</Badge><Badge tone="violet">{s.language}</Badge></div>
                    <div className="muted truncate text-xs">{s.repo ?? ""} {s.path}:{s.line_start}{s.commit_sha ? ` @${s.commit_sha.slice(0, 8)}` : ""}</div>
                  </button>
                </li>
              ))}
            </ul>
          ) : <Empty>No symbols found.</Empty>}
        </Card>
        <Card title="Source">
          {chunk ? (
            <div className="space-y-2">
              <div className="flex flex-wrap gap-1.5 text-xs">
                <Badge tone="violet">Tier 3 · reference implementation (not normative)</Badge>
                {chunk.license && <Badge>{chunk.license}</Badge>}
                {chunk.commit_sha && <Badge>commit {chunk.commit_sha.slice(0, 12)}</Badge>}
              </div>
              <CodeBlock code={chunk.content} language={chunk.language} title={`${chunk.repo_path}:${chunk.line_start}-${chunk.line_end}`} />
              <Link className="text-xs underline" href={`/?q=${encodeURIComponent(`Which 3GPP clauses describe ${chunk.symbol ?? ""}`)}`}>Ask which normative clauses relate to this code →</Link>
            </div>
          ) : <div className="muted text-sm">Select a symbol to view its code.</div>}
        </Card>
      </div>
    </div>
  );
}
