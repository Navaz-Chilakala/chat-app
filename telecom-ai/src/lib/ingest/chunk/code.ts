import type { ChunkDraft, ChunkResult, CodeSymbolDraft } from "../types";
import { makeChunk } from "./common";

export const CODE_EXTENSIONS: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  py: "python", go: "go", c: "c", h: "c", cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp",
  java: "java", kt: "kotlin", rs: "rust", rb: "ruby", sh: "bash", bash: "bash", sql: "sql", proto: "protobuf",
  asn: "asn1", asn1: "asn1", yaml: "yaml", yml: "yaml", json: "json", toml: "toml", xml: "xml", cmake: "cmake",
  lua: "lua", cs: "csharp", swift: "swift", scala: "scala", erl: "erlang", ex: "elixir", conf: "config", cfg: "config",
  ini: "config", dockerfile: "dockerfile", mk: "make", makefile: "make",
};

export function languageForPath(p: string): string | null {
  const base = p.split("/").pop()!.toLowerCase();
  if (base === "dockerfile") return "dockerfile";
  if (base === "makefile" || base === "cmakelists.txt") return base === "makefile" ? "make" : "cmake";
  const ext = base.includes(".") ? base.split(".").pop()! : "";
  return CODE_EXTENSIONS[ext] ?? null;
}

const C_KEYWORDS = new Set(["if", "for", "while", "switch", "return", "sizeof", "else", "do", "case"]);

interface SymbolMatch {
  name: string;
  kind: string;
}

function matchSymbol(line: string, lang: string): SymbolMatch | null {
  let m: RegExpExecArray | null;
  switch (lang) {
    case "typescript":
    case "javascript":
      if ((m = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/.exec(line))) return { name: m[1]!, kind: "function" };
      if ((m = /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(line))) return { name: m[1]!, kind: "class" };
      if ((m = /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.exec(line)))
        return { name: m[1]!, kind: "function" };
      if ((m = /^(?:export\s+)?(?:declare\s+)?(interface|type|enum)\s+([A-Za-z_$][\w$]*)/.exec(line))) return { name: m[2]!, kind: m[1]! };
      return null;
    case "python":
      if ((m = /^(?:async\s+)?def\s+([A-Za-z_]\w*)/.exec(line))) return { name: m[1]!, kind: "function" };
      if ((m = /^class\s+([A-Za-z_]\w*)/.exec(line))) return { name: m[1]!, kind: "class" };
      return null;
    case "go":
      if ((m = /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/.exec(line))) return { name: m[1]!, kind: "function" };
      if ((m = /^type\s+([A-Za-z_]\w*)\s+(struct|interface)/.exec(line))) return { name: m[1]!, kind: m[2]! };
      return null;
    case "c":
    case "cpp":
      if (/^\s|^#|^\/|^\*|;\s*$/.test(line)) return null;
      if ((m = /^(?:typedef\s+)?(struct|enum|union|class)\s+([A-Za-z_]\w*)\s*\{?\s*$/.exec(line))) return { name: m[2]!, kind: m[1]! };
      if ((m = /^[A-Za-z_][\w\s\*:<>,]*?[\s\*&]([A-Za-z_][\w:]*)\s*\([^;]*$/.exec(line)) && !C_KEYWORDS.has(m[1]!)) return { name: m[1]!, kind: "function" };
      return null;
    case "java":
    case "kotlin":
    case "csharp":
    case "scala":
      if ((m = /^\s{0,4}(?:public|private|protected|internal)?\s*(?:static\s+|final\s+|abstract\s+|data\s+|sealed\s+|open\s+)*(class|interface|enum|object|record)\s+([A-Za-z_]\w*)/.exec(line)))
        return { name: m[2]!, kind: m[1]! };
      if ((m = /^\s{2,4}(?:public|private|protected|internal|override)[\w\s<>,\[\]]*?\s([a-zA-Z_]\w*)\s*\([^;]*$/.exec(line)) || (m = /^\s{0,4}fun\s+(?:<[^>]+>\s*)?([a-zA-Z_]\w*)/.exec(line)))
        return { name: m[1]!, kind: "method" };
      return null;
    case "rust":
      if ((m = /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/.exec(line))) return { name: m[1]!, kind: "function" };
      if ((m = /^(?:pub(?:\([^)]*\))?\s+)?(struct|enum|trait|impl)\s+(?:<[^>]+>\s*)?([A-Za-z_]\w*)/.exec(line))) return { name: m[2]!, kind: m[1]! };
      return null;
    case "asn1":
      // ASN.1 type/value assignments, e.g. "InitialUEMessage ::= SEQUENCE {" or "id-InitialUEMessage ProcedureCode ::= 15"
      if ((m = /^([A-Za-z][\w-]*)(?:\s+[A-Z][\w-]*)?\s*::=/.exec(line))) return { name: m[1]!, kind: "asn1-definition" };
      return null;
    case "protobuf":
      if ((m = /^\s*(message|service|enum)\s+([A-Za-z_]\w*)/.exec(line))) return { name: m[2]!, kind: m[1]! };
      if ((m = /^\s+rpc\s+([A-Za-z_]\w*)/.exec(line))) return { name: m[1]!, kind: "rpc" };
      return null;
    default:
      return null;
  }
}

/**
 * Code names -> message-style identifiers. Handles snake_case (ngap_handle_initial_ue_message),
 * camelCase (sendInitialUeMessage) and mixed (ASN_NGAP_InitialUEMessage): the trailing 3-6 name parts
 * are joined so each matches the normalised message identifier (msg:initialuemessage).
 */
export function codeNameIdentifiers(code: string): string[] {
  const out = new Set<string>();
  for (const m of code.matchAll(/\b[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)*\b/g)) {
    const name = m[0];
    if (name.length < 10) continue;
    const parts = name
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .split("_")
      .filter(Boolean)
      .map((p) => p.toLowerCase());
    if (parts.length < 3) continue;
    out.add(`msg:${parts.join("")}`);
    for (let k = 3; k <= Math.min(6, parts.length - 1); k++) out.add(`msg:${parts.slice(-k).join("")}`);
  }
  return [...out].slice(0, 400);
}

const MAX_LINES = 160;

export interface CodeChunkOptions {
  path: string;
  repo?: string | null;
  commit?: string | null;
}

export function chunkCode(source: string, opts: CodeChunkOptions): ChunkResult {
  const lang = languageForPath(opts.path) ?? "text";
  const lines = source.split(/\r?\n/);
  const starts: { line: number; sym: SymbolMatch }[] = [];
  lines.forEach((l, i) => {
    const s = matchSymbol(l, lang);
    if (s) starts.push({ line: i, sym: s });
  });

  // Extend each symbol start upward over its leading comment block.
  const commentRe = /^\s*(\/\/|\/\*|\*|#(?!include|define|if|endif|pragma)|--|""")/;
  const segStarts = starts.map(({ line, sym }) => {
    let s = line;
    while (s > 0 && commentRe.test(lines[s - 1]!)) s--;
    return { line: s, symLine: line, sym };
  });

  const segments: { start: number; end: number; sym: SymbolMatch | null; symLine: number | null }[] = [];
  let cursor = 0;
  for (let i = 0; i < segStarts.length; i++) {
    const cur = segStarts[i]!;
    if (cur.line > cursor) segments.push({ start: cursor, end: cur.line, sym: null, symLine: null });
    const end = i + 1 < segStarts.length ? segStarts[i + 1]!.line : lines.length;
    segments.push({ start: Math.max(cur.line, cursor), end, sym: cur.sym, symLine: cur.symLine });
    cursor = end;
  }
  if (cursor < lines.length) segments.push({ start: cursor, end: lines.length, sym: null, symLine: null });

  // Merge tiny unnamed segments and split oversized ones on blank lines.
  const finalSegs: typeof segments = [];
  for (const seg of segments) {
    const len = seg.end - seg.start;
    if (len <= MAX_LINES) {
      const prev = finalSegs[finalSegs.length - 1];
      if (!seg.sym && prev && !prev.sym && prev.end - prev.start + len <= MAX_LINES) prev.end = seg.end;
      else finalSegs.push({ ...seg });
      continue;
    }
    let s = seg.start;
    while (s < seg.end) {
      let e = Math.min(seg.end, s + MAX_LINES);
      if (e < seg.end) {
        for (let k = e; k > s + MAX_LINES / 2; k--) if (!lines[k]!.trim()) { e = k; break; }
      }
      finalSegs.push({ start: s, end: e, sym: seg.sym, symLine: seg.symLine });
      s = e;
    }
  }

  const chunks: ChunkDraft[] = [];
  const codeSymbols: CodeSymbolDraft[] = [];
  let ord = 0;
  // Machine-generated sources (asn1c, protoc, OpenAPI generators) are kept but ranked below hand-written code.
  const generated = /generated by|do not edit|autogenerated|auto-generated|asn1c|code generator/i.test(source.slice(0, 3000));
  const headingPath = [opts.repo, opts.path].filter(Boolean).join(" : ");
  for (const seg of finalSegs) {
    const content = lines.slice(seg.start, seg.end).join("\n").replace(/\s+$/, "");
    if (!content.trim()) continue;
    const ids = [`path:${opts.path.toLowerCase()}`, ...codeNameIdentifiers(content)];
    if (seg.sym) ids.push(`sym:${seg.sym.name.toLowerCase()}`);
    const chunk = makeChunk({
      ord: ord,
      chunkType: lang === "yaml" || lang === "json" || lang === "toml" || lang === "config" ? "config" : "code",
      content,
      headingPath,
      symbol: seg.sym?.name ?? null,
      language: lang,
      lineStart: seg.start + 1,
      lineEnd: seg.end,
      identifiers: ids,
      metadata: { path: opts.path, repo: opts.repo ?? null, commit: opts.commit ?? null, symbolKind: seg.sym?.kind ?? null },
    });
    // Code is not normative text; "shall" in comments must not be treated as a requirement.
    chunk.flags = chunk.flags.filter((f) => f !== "normative");
    if (generated) chunk.flags.push("generated");
    chunks.push(chunk);
    if (seg.sym && seg.symLine !== null && seg.start <= seg.symLine) {
      codeSymbols.push({ chunkOrd: ord, name: seg.sym.name, kind: seg.sym.kind, path: opts.path, language: lang, lineStart: seg.symLine + 1, lineEnd: seg.end });
    }
    ord++;
  }
  return { strategy: `code-symbol-aware:${lang}`, sections: [], chunks, codeSymbols, warnings: [] };
}
