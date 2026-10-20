import type { Block, ExtractedDocument } from "../types";

const CLAUSE_HEADING_RE = /^((?:[A-Z]\.)?\d{1,2}(?:\.\d{1,3}){0,7})\s+([A-Z(][^]{1,140})$/;
const ANNEX_RE = /^Annex\s+([A-Z])\s*(?:\((?:normative|informative)\))?\s*:?\s*(.*)$/i;
const TOC_LINE_RE = /(\.{4,}|…{2,})\s*\d+\s*$|\t\d+\s*$/;

/** Heuristic block segmentation for text without style information (PDF, legacy .doc, .txt). */
export function linesToBlocks(lines: { text: string; page?: number; large?: boolean }[]): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  let paraPage: number | undefined;
  const flush = () => {
    if (para.length) blocks.push({ type: "para", text: para.join(" ").replace(/\s+/g, " ").trim(), page: paraPage });
    para = [];
  };
  for (const { text: raw, page, large } of lines) {
    const line = raw.replace(/ /g, " ").trim();
    if (!line) {
      flush();
      continue;
    }
    if (TOC_LINE_RE.test(line)) continue;
    const h = CLAUSE_HEADING_RE.exec(line);
    const annex = ANNEX_RE.exec(line);
    if (h && !/\.\s*$/.test(line) && !/\bshall\b/.test(line) && line.length < 150 && !/^\d+\s+\d/.test(line)) {
      flush();
      blocks.push({ type: "heading", text: line, level: h[1]!.split(".").length, page });
      continue;
    }
    if (annex && line.length < 150) {
      flush();
      blocks.push({ type: "heading", text: line, level: 1, page });
      continue;
    }
    if (large && line.length < 120) {
      flush();
      blocks.push({ type: "heading", text: line, level: 1, page });
      continue;
    }
    if (/^(NOTE\s*\d*:|NOTE:)/.test(line)) {
      flush();
      blocks.push({ type: "note", text: line, page });
      continue;
    }
    if (/^(Table|Figure)\s+[\dA-Z][\w.\-]*[:\s]/.test(line) && line.length < 200) {
      flush();
      blocks.push({ type: "caption", text: line, page });
      continue;
    }
    if (!para.length) paraPage = page;
    para.push(line);
    if (/[.:;]$/.test(line) && para.join(" ").length > 600) flush();
  }
  flush();
  return blocks;
}

export function extractPlainText(text: string): ExtractedDocument {
  const blocks = linesToBlocks(text.split(/\r?\n/).map((t) => ({ text: t })));
  return { blocks, pageCount: null, warnings: [], head: text.slice(0, 4000), format: "text" };
}

export function extractMarkdown(md: string): ExtractedDocument {
  const blocks: Block[] = [];
  let para: string[] = [];
  let inCode = false;
  let code: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ type: "para", text: para.join(" ").trim() });
    para = [];
  };
  for (const line of md.split(/\r?\n/)) {
    if (/^```/.test(line.trim())) {
      if (inCode) {
        blocks.push({ type: "code", text: code.join("\n") });
        code = [];
        inCode = false;
      } else {
        flush();
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      code.push(line);
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      blocks.push({ type: "heading", text: h[2]!.trim(), level: h[1]!.length });
    } else if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      flush();
      blocks.push({ type: "list", text: line.replace(/^\s*([-*+]|\d+\.)\s+/, "").trim() });
    } else if (/^\s*\|.*\|\s*$/.test(line)) {
      flush();
      const cells = line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;
      const last = blocks[blocks.length - 1];
      if (last?.type === "table" && last.rows) {
        last.rows.push(cells);
        last.text += `\n${cells.join(" | ")}`;
      } else blocks.push({ type: "table", text: cells.join(" | "), rows: [cells] });
    } else if (!line.trim()) flush();
    else para.push(line.trim());
  }
  flush();
  if (inCode && code.length) blocks.push({ type: "code", text: code.join("\n") });
  return { blocks, pageCount: null, warnings: [], head: md.slice(0, 4000), format: "markdown" };
}
