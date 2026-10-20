import { extractIdentifiers, isNormativeSentence, looksLikePromptInjection } from "../../telecom/identifiers";
import { estimateTokens, type ChunkDraft } from "../types";

export const TARGET_TOKENS = 320;
export const MAX_TOKENS = 520;

export function splitSentences(text: string): string[] {
  // Avoid splitting on clause numbers ("4.2.2"), abbreviations ("e.g.", "i.e.", "etc.") and decimals.
  const protectedText = text.replace(/\b(e\.g|i\.e|etc|cf|vs|Fig|No|Ref)\./g, "$1\u0000");
  return protectedText
    .split(/(?<=[.!?;])\s+(?=[A-Z0-9("\-])/)
    .map((s) => s.replace(/\u0000/g, ".").trim())
    .filter(Boolean);
}

export function baseFlags(text: string): string[] {
  const flags: string[] = [];
  if (splitSentences(text).some(isNormativeSentence)) flags.push("normative");
  if (looksLikePromptInjection(text)) flags.push("suspicious_instructions");
  return flags;
}

export function makeChunk(partial: Partial<ChunkDraft> & { content: string; ord: number; chunkType: string }): ChunkDraft {
  const ids = new Set(extractIdentifiers(`${partial.headingPath ?? ""}\n${partial.content}`));
  if (partial.clause) ids.add(`clause:${partial.clause}`);
  for (const i of partial.identifiers ?? []) ids.add(i);
  const flags = new Set([...(partial.flags ?? []), ...baseFlags(partial.content)]);
  return {
    sectionKey: null,
    clause: null,
    headingPath: null,
    pageStart: null,
    pageEnd: null,
    symbol: null,
    language: null,
    lineStart: null,
    lineEnd: null,
    metadata: {},
    ...partial,
    identifiers: [...ids],
    flags: [...flags],
    tokenCount: estimateTokens(partial.content),
  };
}

/** Pack text units into chunks near TARGET_TOKENS, never exceeding MAX_TOKENS (long units are sentence-split). */
export function packUnits(units: string[], overlapLastUnit = true): string[] {
  const expanded: string[] = [];
  for (const u of units) {
    if (estimateTokens(u) <= MAX_TOKENS) expanded.push(u);
    else {
      let buf = "";
      for (const s of splitSentences(u)) {
        if (buf && estimateTokens(buf + " " + s) > TARGET_TOKENS) {
          expanded.push(buf);
          buf = s;
        } else buf = buf ? `${buf} ${s}` : s;
      }
      if (buf) expanded.push(buf);
    }
  }
  const out: string[] = [];
  let cur: string[] = [];
  let curTokens = 0;
  for (const u of expanded) {
    const t = estimateTokens(u);
    if (cur.length && curTokens + t > TARGET_TOKENS) {
      out.push(cur.join("\n"));
      const last = cur[cur.length - 1]!;
      // Overlap: repeat a short trailing unit so a requirement split across chunks keeps its lead-in.
      cur = overlapLastUnit && estimateTokens(last) < 80 ? [last] : [];
      curTokens = cur.length ? estimateTokens(last) : 0;
    }
    cur.push(u);
    curTokens += t;
  }
  if (cur.length) out.push(cur.join("\n"));
  return out;
}

export function rowsToMarkdown(rows: string[][]): string {
  if (!rows.length) return "";
  const width = Math.max(...rows.map((r) => r.length));
  const norm = rows.map((r) => [...r, ...Array(width - r.length).fill("")].map((c) => c.replace(/\|/g, "\\|")));
  const [head, ...body] = norm;
  return [`| ${head!.join(" | ")} |`, `| ${head!.map(() => "---").join(" | ")} |`, ...body.map((r) => `| ${r.join(" | ")} |`)].join("\n");
}
