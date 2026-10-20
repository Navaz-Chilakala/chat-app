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

/** Unpack a 3GPP deliverable zip: choose the main document (.docx > .doc > .pdf), report the rest. */
export function unpackSpecZip(buf: Buffer): { name: string; data: Buffer; others: string[] } {
  const files = unzipSync(new Uint8Array(buf));
  const names = Object.keys(files).filter((n) => !n.endsWith("/") && !n.startsWith("__MACOSX"));
  const rank = (n: string) => (/\.docx$/i.test(n) ? 0 : /\.doc$/i.test(n) ? 1 : /\.pdf$/i.test(n) ? 2 : 9);
  const docs = names.filter((n) => rank(n) < 9).sort((a, b) => rank(a) - rank(b) || files[b]!.length - files[a]!.length);
  if (!docs.length) throw new Error(`Zip contains no .docx/.doc/.pdf document (files: ${names.slice(0, 10).join(", ")})`);
  const main = docs[0]!;
  return { name: main, data: Buffer.from(files[main]!), others: names.filter((n) => n !== main) };
}

export async function processFile(buf: Buffer, filename: string, ctx: { docLabel?: string; repo?: string | null; commit?: string | null } = {}): Promise<ProcessOutput> {
  let format = sniffFormat(buf, filename);
  let innerFilename: string | null = null;
  const zipWarnings: string[] = [];
  if (format === "zip") {
    const { name, data, others } = unpackSpecZip(buf);
    innerFilename = name;
    if (others.length) zipWarnings.push(`Zip also contained ${others.length} file(s) not indexed as separate documents: ${others.slice(0, 8).join(", ")}${others.length > 8 ? "…" : ""}`);
    buf = data;
    format = sniffFormat(buf, name);
  }

  let extracted: ExtractedDocument | null = null;
  let result: ChunkResult;
  let language: string | null = null;
  switch (format) {
    case "pdf":
      extracted = await extractPdf(buf);
      break;
    case "docx":
      extracted = await extractDocx(buf);
      break;
    case "doc":
      extracted = await extractDoc(buf);
      break;
    case "html":
      extracted = extractHtml(buf.toString("utf8"));
      break;
    case "markdown":
      extracted = extractMarkdown(buf.toString("utf8"));
      break;
    case "text":
      if (looksBinary(buf)) throw new Error("File appears to be binary and is not a supported document type");
      extracted = extractPlainText(buf.toString("utf8"));
      break;
    default:
      break;
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
