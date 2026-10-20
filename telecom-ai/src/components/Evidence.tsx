"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { EvidenceItem } from "./types";
import { Badge, SOURCE_TYPE_LABEL, TIER_LABEL, Spinner } from "./ui";
import { CodeBlock } from "./CodeBlock";
import { MarkdownTable } from "./MarkdownTable";
import { api } from "@/lib/client";

export function citeLabel(e: Pick<EvidenceItem, "specNumber" | "specType" | "version" | "clause" | "repoPath" | "lineStart" | "lineEnd" | "commitSha" | "title">): string {
  if (e.specNumber) return `${e.specType ?? "TS"} ${e.specNumber}${e.version ? ` V${e.version}` : ""}${e.clause ? ` §${e.clause}` : ""}`;
  if (e.repoPath) return `${e.repoPath}${e.lineStart ? `:${e.lineStart}-${e.lineEnd}` : ""}${e.commitSha ? ` @${e.commitSha.slice(0, 8)}` : ""}`;
  return e.title;
}

export function EvidenceBadges({ e }: { e: EvidenceItem }) {
  const tier = TIER_LABEL[e.authorityTier];
  return (
    <div className="flex flex-wrap gap-1">
      {tier && <Badge tone={tier.tone}>{tier.label}</Badge>}
      <Badge>{SOURCE_TYPE_LABEL[e.sourceType] ?? e.sourceType}</Badge>
      {e.release != null && <Badge tone="blue">Rel-{e.release}</Badge>}
      {!e.isCurrent && <Badge tone="amber" title="Not the current version of this document">historical version</Badge>}
      {e.chunkType !== "text" && <Badge tone="violet">{e.chunkType.replace("_", " ")}</Badge>}
      {e.flags.includes("normative") && <Badge tone="green">normative</Badge>}
      {e.flags.includes("ocr") && <Badge tone="amber" title="Text recovered by OCR — machine-extracted">OCR</Badge>}
      {e.flags.includes("ocr_low_confidence") && <Badge tone="red">low OCR confidence</Badge>}
      {e.flags.includes("suspicious_instructions") && <Badge tone="red" title="Contains instruction-like text; treated as data only">untrusted text</Badge>}
      {e.pageStart && <Badge>p. {e.pageStart}{e.pageEnd && e.pageEnd !== e.pageStart ? `–${e.pageEnd}` : ""}</Badge>}
    </div>
  );
}

export function EvidenceContent({ e, full = false }: { e: EvidenceItem; full?: boolean }) {
  if (e.chunkType === "code" || e.chunkType === "config") return <CodeBlock code={e.content} language={e.language} title={e.repoPath ?? undefined} startLine={e.lineStart} />;
  if (e.chunkType === "table") {
    const lines = e.content.split("\n");
    const caption = lines[0]?.startsWith("|") ? null : lines[0];
    return (
      <div className="space-y-1">
        {caption && <div className="text-xs font-medium">{caption}</div>}
        <MarkdownTable markdown={caption ? lines.slice(1).join("\n") : e.content} />
      </div>
    );
  }
  const text = full ? e.content : e.content.length > 900 ? `${e.content.slice(0, 900)}…` : e.content;
  return <div className="whitespace-pre-wrap text-sm leading-6">{text}</div>;
}

export function EvidenceCard({ e, highlight = false }: { e: EvidenceItem; highlight?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div id={`ev-${e.n}`} className={`panel p-3 ${highlight ? "ring-2 ring-brand-500" : ""}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-semibold">
            <span className="mr-1.5 font-mono text-brand-600">[{e.n}]</span>
            {citeLabel(e)}
          </div>
          <div className="muted truncate text-xs" title={e.headingPath ?? e.title}>{e.headingPath ?? e.title}</div>
        </div>
        <div className="flex gap-1.5">
          <button className="btn !px-2 !py-1 text-xs" onClick={() => setOpen((o) => !o)}>{open ? "Less" : "Context"}</button>
          <Link className="btn !px-2 !py-1 text-xs" href={`/documents/${e.documentId}?version=${e.versionId}&chunk=${e.chunkId}`}>Open source</Link>
        </div>
      </div>
      <div className="mt-2"><EvidenceBadges e={e} /></div>
      <div className="mt-2">
        {open && e.contextBefore && <div className="muted mb-1 whitespace-pre-wrap border-l-2 border-dashed pl-2 text-xs">…{e.contextBefore}</div>}
        <EvidenceContent e={e} full={open} />
        {open && e.contextAfter && <div className="muted mt-1 whitespace-pre-wrap border-l-2 border-dashed pl-2 text-xs">{e.contextAfter}…</div>}
      </div>
      <div className="muted mt-2 flex flex-wrap gap-x-3 text-[11px]">
        <span>matched by: {e.channels.join(", ")}</span>
        <span>score {e.score}</span>
        {e.sourceUrl && <a className="underline" href={e.sourceUrl} target="_blank" rel="noopener noreferrer nofollow">source URL</a>}
        {e.license && <span>license: {e.license}</span>}
      </div>
    </div>
  );
}

/** Slide-over showing one citation, fetched fresh (server enforces access). */
export function CitationDrawer({ evidence, onClose }: { evidence: EvidenceItem | null; onClose: () => void }) {
  const [siblings, setSiblings] = useState<{ id: string; content: string; chunk_type: string }[] | null>(null);
  useEffect(() => {
    setSiblings(null);
    if (!evidence) return;
    api<{ siblings: { id: string; content: string; chunk_type: string }[] }>(`/api/chunks/${evidence.chunkId}`).then((r) => setSiblings(r.siblings)).catch(() => setSiblings([]));
  }, [evidence]);
  if (!evidence) return null;
  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal>
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="absolute inset-y-0 right-0 flex w-full max-w-2xl flex-col bg-[var(--bg)] shadow-xl">
        <div className="flex items-center justify-between border-b hairline px-4 py-3">
          <div className="text-sm font-semibold">Citation [{evidence.n}] — {citeLabel(evidence)}</div>
          <button className="btn !px-2 !py-1" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="flex-1 space-y-3 overflow-y-auto p-4">
          <EvidenceCard e={evidence} highlight />
          <div className="text-xs font-semibold uppercase tracking-wide">Full clause / surrounding text</div>
          {siblings === null ? (
            <Spinner />
          ) : (
            siblings.map((s) => (
              <div key={s.id} className={`rounded-lg border hairline p-3 text-sm whitespace-pre-wrap ${s.id === evidence.chunkId ? "border-brand-500 bg-brand-50/40 dark:bg-brand-700/10" : ""}`}>
                {s.content}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
