import { unzipSync } from "fflate";
import type { ChunkResult, ExtractedDocument } from "./types";
import { extractDocx } from "./extract/docx";
import { extractDoc } from "./extract/doc";
import { extractPdf } from "./extract/pdf";
import { extractHtml } from "./extract/html";
import { extractMarkdown, extractPlainText } from "./extract/plaintext";
import { chunkDocument } from "./chunk/document";
import { chunkCode, languageForPath } from "./chunk/code";
import { chunkOpenApi, isOpenApiDocument, parseStructured } from "./chunk/openapi";
import { rowsToMarkdown } from "./chunk/common";
import { makeChunk } from "./chunk/common";

export type DetectedFormat = "pdf" | "docx" | "doc" | "html" | "markdown" | "text" | "openapi" | "code" | "csv" | "zip";

export const SUPPORTED_EXTENSIONS = [
  "pdf", "docx", "doc", "txt", "md", "markdown", "html", "htm", "csv", "json", "yaml", "yml", "xml", "zip",
  "ts", "tsx", "js", "jsx", "py", "go", "c", "h", "cc", "cpp", "hpp", "java", "kt", "rs", "sh", "sql", "proto", "asn", "asn1", "toml",
];

export function extensionOf(filename: string): string {
  const base = filename.split("/").pop()!.toLowerCase();
  return base.includes(".") ? base.split(".").pop()! : "";
}

export function sniffFormat(buf: Buffer, filename: string): DetectedFormat {
  const ext = extensionOf(filename);
  const magic = buf.subarray(0, 8);
  if (magic.subarray(0, 5).toString("latin1") === "%PDF-") return "pdf";
  if (magic[0] === 0x50 && magic[1] === 0x4b) return ext === "docx" ? "docx" : ext === "zip" ? "zip" : ext === "docx" ? "docx" : isDocxZip(buf) ? "docx" : "zip";
  if (magic.readUInt32BE(0) === 0xd0cf11e0) return "doc";
  if (ext === "md" || ext === "markdown") return "markdown";
  if (ext === "html" || ext === "htm") return "html";
  if (ext === "csv") return "csv";
  if (ext === "json" || ext === "yaml" || ext === "yml") {
    try {
      if (isOpenApiDocument(parseStructured(buf.toString("utf8")))) return "openapi";
    } catch {
      /* fall through to code */
    }
    return "code";
  }
  if (languageForPath(filename)) return "code";
  const head = buf.subarray(0, 512).toString("utf8").toLowerCase();
  if (head.includes("<html") || head.includes("<!doctype html")) return "html";
  return "text";
}

function isDocxZip(buf: Buffer): boolean {
  try {
    const files = unzipSync(new Uint8Array(buf), { filter: (f) => f.name === "word/document.xml" });
    return "word/document.xml" in files;
  } catch {
    return false;
  }
}

/** Reject binary payloads masquerading as text (e.g. executables renamed to .txt). */
export function looksBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, 8000);
  let nonText = 0;
  for (const b of sample) if (b === 0 || (b < 7 && b !== 9 && b !== 10 && b !== 13)) nonText++;
  return nonText > sample.length * 0.01;
}

export interface ProcessOutput {
  format: DetectedFormat;
  innerFilename: string | null;
  extracted: ExtractedDocument | null;
  result: ChunkResult;
  pageCount: number | null;
  language: string | null;
}

/**
 * Unpack a 3GPP deliverable zip. Large specifications (e.g. TS 24.501, TS 38.331) are delivered as several
 * Word files covering consecutive clause ranges (`24501-k10_s00-s0805.docx`, `24501-k10_s0806-s10.docx`, ...),
 * so every document of the best available format is returned, in clause order.
 */
export function unpackSpecZip(buf: Buffer): { parts: { name: string; data: Buffer }[]; others: string[] } {
  const files = unzipSync(new Uint8Array(buf));
  const names = Object.keys(files).filter((n) => !n.endsWith("/") && !n.startsWith("__MACOSX") && !/(^|\/)~\$/.test(n));
  const rank = (n: string) => (/\.docx$/i.test(n) ? 0 : /\.doc$/i.test(n) ? 1 : /\.pdf$/i.test(n) ? 2 : 9);
  const best = Math.min(9, ...names.map(rank));
  if (best === 9) throw new Error(`Zip contains no .docx/.doc/.pdf document (files: ${names.slice(0, 10).join(", ")})`);
  const parts = names
    .filter((n) => rank(n) === best)
    // Clause ranges are zero-padded two-digit groups (s0806 = 8.6 < s10), so plain ordinal order is clause order.
    .sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0))
    .map((name) => ({ name, data: Buffer.from(files[name]!) }));
  return { parts, others: names.filter((n) => rank(n) !== best) };
}

/** Concatenate the extracted parts of a multi-file deliverable, keeping page numbers monotonic. */
export function mergeExtracted(parts: ExtractedDocument[]): ExtractedDocument {
  if (parts.length === 1) return parts[0]!;
  const blocks: ExtractedDocument["blocks"] = [];
  const ocrPages: Record<number, number> = {};
  const warnings: string[] = [];
  let pageOffset = 0;
  let pageCount: number | null = 0;
  let ocrStats: ExtractedDocument["ocrStats"];
  for (const p of parts) {
    for (const b of p.blocks) blocks.push(b.page != null ? { ...b, page: b.page + pageOffset } : b);
    for (const [pg, conf] of Object.entries(p.ocrPages ?? {})) ocrPages[Number(pg) + pageOffset] = conf;
    warnings.push(...p.warnings);
    if (p.ocrStats) {
      ocrStats ??= { images: 0, recognised: 0, lowConfidence: 0, skippedUnsupported: 0 };
      ocrStats.images += p.ocrStats.images;
      ocrStats.recognised += p.ocrStats.recognised;
      ocrStats.lowConfidence += p.ocrStats.lowConfidence;
      ocrStats.skippedUnsupported += p.ocrStats.skippedUnsupported;
    }
    pageOffset += p.pageCount ?? 0;
    pageCount = pageCount != null && p.pageCount != null ? pageCount + p.pageCount : null;
  }
  return {
    blocks,
    pageCount,
    warnings: [...new Set(warnings)],
    head: parts[0]!.head,
    format: parts[0]!.format,
    ...(Object.keys(ocrPages).length ? { ocrPages } : {}),
    ...(ocrStats ? { ocrStats } : {}),
  };
}

async function extractByFormat(format: DetectedFormat, buf: Buffer): Promise<ExtractedDocument | null> {
  switch (format) {
    case "pdf":
      return extractPdf(buf);
    case "docx":
      return extractDocx(buf);
    case "doc":
      return extractDoc(buf);
    case "html":
      return extractHtml(buf.toString("utf8"));
    case "markdown":
      return extractMarkdown(buf.toString("utf8"));
    case "text":
      if (looksBinary(buf)) throw new Error("File appears to be binary and is not a supported document type");
      return extractPlainText(buf.toString("utf8"));
    default:
      return null;
  }
}

export async function processFile(buf: Buffer, filename: string, ctx: { docLabel?: string; repo?: string | null; commit?: string | null } = {}): Promise<ProcessOutput> {
  let format = sniffFormat(buf, filename);
  let innerFilename: string | null = null;
  const zipWarnings: string[] = [];
  let extracted: ExtractedDocument | null = null;
  let result: ChunkResult;
  let language: string | null = null;
  if (format === "zip") {
    const { parts, others } = unpackSpecZip(buf);
    innerFilename = parts.map((p) => p.name).join(" + ");
    if (parts.length > 1) zipWarnings.push(`Deliverable split into ${parts.length} files, indexed in order: ${parts.map((p) => p.name).join(", ")}`);
    if (others.length) zipWarnings.push(`Zip also contained ${others.length} file(s) not indexed: ${others.slice(0, 8).join(", ")}${others.length > 8 ? "…" : ""}`);
    format = sniffFormat(parts[0]!.data, parts[0]!.name);
    const docs: ExtractedDocument[] = [];
    for (const p of parts) {
      const d = await extractByFormat(sniffFormat(p.data, p.name), p.data);
      if (d) docs.push(d);
    }
    if (docs.length) extracted = mergeExtracted(docs);
    else buf = parts[0]!.data;
  } else {
    extracted = await extractByFormat(format, buf);
  }

  if (extracted) {
    result = chunkDocument(extracted, { docLabel: ctx.docLabel });
    result.warnings.unshift(...zipWarnings, ...extracted.warnings);
  } else if (format === "openapi") {
    const doc = parseStructured(buf.toString("utf8"));
    result = chunkOpenApi(doc as Record<string, unknown>, filename);
    language = filename.endsWith(".json") ? "json" : "yaml";
  } else if (format === "csv") {
    const rows = buf
      .toString("utf8")
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .map((l) => l.split(",").map((c) => c.replace(/^"|"$/g, "").trim()));
    const [header, ...body] = rows;
    const chunks = [];
    for (let i = 0, ord = 0; i < Math.max(body.length, 1); i += 40, ord++) {
      chunks.push(makeChunk({ ord, chunkType: "table", content: rowsToMarkdown([header ?? [], ...body.slice(i, i + 40)]), headingPath: filename }));
    }
    result = { strategy: "csv-rows", sections: [], chunks, warnings: [] };
  } else {
    if (looksBinary(buf)) throw new Error("File appears to be binary and is not a supported source/text type");
    result = chunkCode(buf.toString("utf8"), { path: filename, repo: ctx.repo, commit: ctx.commit });
    language = languageForPath(filename);
  }
  return { format, innerFilename, extracted, result, pageCount: extracted?.pageCount ?? null, language };
}
