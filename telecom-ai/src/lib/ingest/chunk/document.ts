import type { Block, ChunkDraft, ChunkResult, ExtractedDocument, SectionDraft } from "../types";
import { estimateTokens } from "../types";
import { MAX_TOKENS, makeChunk, packUnits, rowsToMarkdown } from "./common";

const CLAUSE_RE = /^((?:[A-Z]\.)?\d{1,2}(?:\.\d{1,3}){0,8})\s+(.+)$/;
const ANNEX_RE = /^Annex\s+([A-Z]{1,2})\b\s*(.*)$/i;
export const HISTORY_RE = /\b(change|revision|document) history\b/i;
const BOILERPLATE_RE = /^(foreword|copyright notification|intellectual property rights|legal notice|modal verbs terminology|contents|keywords)$/i;

interface OpenSection {
  draft: SectionDraft;
  path: string[];
  units: Block[];
}

function parseHeading(text: string, fallbackLevel: number): { clause: string | null; title: string; level: number } {
  const c = CLAUSE_RE.exec(text);
  if (c) {
    const clause = c[1]!;
    const parts = clause.split(".");
    return { clause, title: c[2]!.trim(), level: parts.length };
  }
  const a = ANNEX_RE.exec(text);
  if (a) return { clause: a[1]!.toUpperCase(), title: text, level: 1 };
  return { clause: null, title: text, level: fallbackLevel };
}

export interface DocumentChunkOptions {
  /** Prefix used in heading paths, e.g. "TS 23.502". */
  docLabel?: string;
}

export function chunkDocument(doc: ExtractedDocument, opts: DocumentChunkOptions = {}): ChunkResult {
  const sections: SectionDraft[] = [];
  const chunks: ChunkDraft[] = [];
  const abbreviations: { chunkOrd: number; abbr: string; expansion: string }[] = [];
  const warnings: string[] = [];
  const stack: OpenSection[] = [];
  let ord = 0;
  let current: OpenSection = {
    draft: { key: "s0", parentKey: null, clause: null, heading: "Front matter", level: 0, ord: 0, pageStart: null, pageEnd: null },
    path: [],
    units: [],
  };
  sections.push(current.draft);

  const pageRange = (blocks: Block[]) => {
    const pages = blocks.map((b) => b.page).filter((p): p is number => typeof p === "number");
    return pages.length ? { pageStart: Math.min(...pages), pageEnd: Math.max(...pages) } : { pageStart: null, pageEnd: null };
  };
  const isOcrPage = (blocks: Block[]) => blocks.some((b) => b.page !== undefined && doc.ocrPages?.[b.page] !== undefined);

  const flushSection = (sec: OpenSection) => {
    const units = sec.units;
    if (!units.length) return;
    const headingPath = [opts.docLabel, ...sec.path].filter(Boolean).join(" > ");
    const heading = sec.draft.heading;
    const boilerplate = BOILERPLATE_RE.test(heading.trim()) || HISTORY_RE.test(heading) || sec.draft.level === 0;
    const isDefinitions = /^definitions\b/i.test(heading) || /^terms and definitions/i.test(heading);
    const isAbbrev = /^abbreviations\b/i.test(heading) || /^symbols and abbreviations/i.test(heading);
    const isReferences = /^(normative )?references$/i.test(heading.trim());
    const range = pageRange(units);
    const sectionFlags = [
      ...(boilerplate ? ["boilerplate"] : []),
      ...(isReferences ? ["references"] : []),
      ...(isOcrPage(units) ? ["ocr"] : []),
    ];
    const base = { sectionKey: sec.draft.key, clause: sec.draft.clause, headingPath, ...range };

    let textBuf: Block[] = [];
    const flushText = () => {
      if (!textBuf.length) return;
      const pieces = packUnits(textBuf.map((b) => (b.type === "list" ? `- ${b.text}` : b.type === "note" ? b.text : b.text)));
      for (const p of pieces) chunks.push(makeChunk({ ...base, ...pageRange(textBuf), ord: ord++, chunkType: "text", content: p, flags: sectionFlags }));
      textBuf = [];
    };

    for (let i = 0; i < units.length; i++) {
      const b = units[i]!;
      if (b.type === "table" && b.rows?.length) {
        flushText();
        // 3GPP puts the table caption (TH style) immediately before the table.
        const prev = units[i - 1];
        const caption = prev?.type === "caption" && /^Table/i.test(prev.text) ? prev.text : null;
        const [header, ...body] = b.rows;
        let group: string[][] = [];
        const emit = () => {
          if (!group.length && body.length) return;
          const md = rowsToMarkdown([header!, ...group]);
          chunks.push(
            makeChunk({ ...base, ...pageRange([b]), ord: ord++, chunkType: "table", content: caption ? `${caption}\n${md}` : md, flags: sectionFlags, metadata: { caption } }),
          );
          group = [];
        };
        for (const row of body) {
          group.push(row);
          if (estimateTokens(rowsToMarkdown([header!, ...group])) > MAX_TOKENS) {
            const last = group.pop()!;
            emit();
            group = [last];
          }
        }
        if (group.length || !body.length) emit();
        continue;
      }
      if (b.type === "figure") {
        flushText();
        // 3GPP puts the figure caption (TF style) immediately after the figure.
        const next = units[i + 1];
        const caption = next?.type === "caption" && /^Figure/i.test(next.text) ? next.text : null;
        const conf = b.ocr ? Math.round(b.ocr.confidence) : null;
        const content = `[Figure text extracted by OCR — machine-generated${conf !== null ? `, confidence ${conf}%` : ""}; verify against the original figure]\n${caption ? `${caption}\n` : ""}${b.text}`;
        chunks.push(
          makeChunk({
            ...base,
            ...pageRange([b]),
            ord: ord++,
            chunkType: "figure_ocr",
            content,
            flags: [...sectionFlags, "ocr", ...(b.ocr?.lowConfidence ? ["ocr_low_confidence"] : [])],
            metadata: { caption, ocrConfidence: b.ocr?.confidence ?? null },
          }),
        );
        continue;
      }
      if (b.type === "caption" && /^Figure/i.test(b.text) && units[i - 1]?.type === "figure") continue; // consumed above
      if (b.type === "caption" && /^Table/i.test(b.text) && units[i + 1]?.type === "table") continue; // consumed below
      if (isDefinitions && (b.type === "para" || b.type === "list") && /^[^:]{2,120}:\s+\S/.test(b.text)) {
        flushText();
        const term = b.text.split(":")[0]!.trim();
        chunks.push(makeChunk({ ...base, ...pageRange([b]), ord: ord++, chunkType: "definition", content: b.text, flags: sectionFlags, metadata: { term } }));
        continue;
      }
      if (isAbbrev && (b.type === "para" || b.type === "list")) {
        const m = /^([A-Za-z0-9][A-Za-z0-9\-/+.]{0,15})\s+([A-Z(].{2,160})$/.exec(b.text);
        if (m) {
          // Collected below into grouped abbreviation chunks.
          textBuf.push({ ...b, style: "abbr" });
          continue;
        }
      }
      if (b.type === "code") {
        flushText();
        chunks.push(makeChunk({ ...base, ...pageRange([b]), ord: ord++, chunkType: "code", content: b.text, flags: sectionFlags }));
        continue;
      }
      textBuf.push(b);
    }

    if (isAbbrev && textBuf.some((b) => b.style === "abbr")) {
      const abbrLines = textBuf.filter((b) => b.style === "abbr");
      textBuf = textBuf.filter((b) => b.style !== "abbr");
      for (let i = 0; i < abbrLines.length; i += 60) {
        const group = abbrLines.slice(i, i + 60);
        const chunkOrd = ord++;
        chunks.push(makeChunk({ ...base, ...pageRange(group), ord: chunkOrd, chunkType: "abbreviation", content: group.map((g) => g.text).join("\n"), flags: sectionFlags }));
        for (const g of group) {
          const m = /^([A-Za-z0-9][A-Za-z0-9\-/+.]{0,15})\s+(.+)$/.exec(g.text)!;
          abbreviations.push({ chunkOrd, abbr: m[1]!, expansion: m[2]!.trim() });
        }
      }
    }
    flushText();
  };

  for (const block of doc.blocks) {
    if (block.type === "heading") {
      flushSection(current);
      const { clause, title, level } = parseHeading(block.text, block.level ?? 1);
      while (stack.length && stack[stack.length - 1]!.draft.level >= level) stack.pop();
      const parent = stack[stack.length - 1];
      const draft: SectionDraft = {
        key: `s${sections.length}`,
        parentKey: parent?.draft.key ?? null,
        clause,
        heading: clause && !ANNEX_RE.test(block.text) ? title : block.text,
        level,
        ord: sections.length,
        pageStart: block.page ?? null,
        pageEnd: block.page ?? null,
      };
      sections.push(draft);
      current = { draft, path: [...(parent?.path ?? []), block.text], units: [] };
      stack.push(current);
      continue;
    }
    current.units.push(block);
    if (block.page) {
      current.draft.pageEnd = block.page;
      current.draft.pageStart ??= block.page;
    }
  }
  flushSection(current);

  if (sections.length <= 1 && doc.blocks.length > 20) warnings.push("No heading structure detected; chunks use paragraph boundaries only.");
  return { strategy: "document-clause-aware", sections, chunks, abbreviations, warnings };
}
