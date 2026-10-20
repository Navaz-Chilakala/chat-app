"use client";

import { useMemo } from "react";
import hljs from "highlight.js/lib/common";
import { CopyButton } from "./ui";

const LANG_ALIASES: Record<string, string> = { asn1: "plaintext", protobuf: "plaintext", config: "ini", text: "plaintext" };

export function CodeBlock({ code, language, title, startLine }: { code: string; language?: string | null; title?: string; startLine?: number | null }) {
  const html = useMemo(() => {
    const lang = LANG_ALIASES[language ?? ""] ?? language ?? "";
    try {
      return lang && hljs.getLanguage(lang) ? hljs.highlight(code, { language: lang }).value : hljs.highlightAuto(code).value;
    } catch {
      return code.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
    }
  }, [code, language]);
  return (
    <div className="overflow-hidden rounded-lg border hairline bg-[#0f172a] text-slate-100">
      <div className="flex items-center justify-between gap-2 border-b border-slate-700/60 px-3 py-1.5 text-xs text-slate-400">
        <span className="truncate font-mono">{title ?? language ?? "code"}{startLine ? ` · line ${startLine}` : ""}</span>
        <CopyButton text={code} />
      </div>
      {/* highlight.js escapes the source; the output contains only its own span markup */}
      <pre className="max-h-[480px] overflow-auto p-3 text-[12.5px] leading-5"><code dangerouslySetInnerHTML={{ __html: html }} /></pre>
    </div>
  );
}
