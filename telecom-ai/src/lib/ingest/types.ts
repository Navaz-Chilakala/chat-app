export type BlockType = "heading" | "para" | "table" | "caption" | "note" | "code" | "list" | "figure";

export interface Block {
  type: BlockType;
  text: string;
  level?: number; // headings
  page?: number;
  rows?: string[][]; // tables (first row = header)
  style?: string;
  /** Present when the text was produced by OCR (figures or scanned pages). */
  ocr?: { confidence: number; lowConfidence: boolean };
}

export interface ExtractedDocument {
  blocks: Block[];
  pageCount: number | null;
  warnings: string[];
  /** First few thousand characters of plain text, used for cover/metadata parsing. */
  head: string;
  format: "docx" | "doc" | "pdf" | "html" | "markdown" | "text";
  /** Scanned pages whose text came from full-page OCR: page -> mean confidence. */
  ocrPages?: Record<number, number>;
  ocrStats?: { images: number; recognised: number; lowConfidence: number; skippedUnsupported: number };
}

export interface SectionDraft {
  key: string;
  parentKey: string | null;
  clause: string | null;
  heading: string;
  level: number;
  ord: number;
  pageStart: number | null;
  pageEnd: number | null;
}

export interface ChunkDraft {
  ord: number;
  chunkType: string;
  content: string;
  sectionKey: string | null;
  clause: string | null;
  headingPath: string | null;
  pageStart: number | null;
  pageEnd: number | null;
  symbol: string | null;
  language: string | null;
  lineStart: number | null;
  lineEnd: number | null;
  identifiers: string[];
  flags: string[];
  metadata: Record<string, unknown>;
  tokenCount: number;
}

export interface StructuredApiOperation {
  chunkOrd: number;
  apiTitle: string;
  apiVersion: string | null;
  openapiVersion: string | null;
  method: string;
  path: string;
  operationId: string | null;
  summary: string | null;
  tags: string[];
  parameters: unknown[];
  requestBody: unknown;
  responses: Record<string, unknown>;
  security: unknown;
  servers: unknown;
  deprecated: boolean;
}

export interface StructuredApiSchema {
  chunkOrd: number;
  name: string;
  schema: unknown;
  required: string[];
}

export interface CodeSymbolDraft {
  chunkOrd: number;
  name: string;
  kind: string;
  path: string;
  language: string;
  lineStart: number;
  lineEnd: number;
}

export interface ChunkResult {
  strategy: string;
  sections: SectionDraft[];
  chunks: ChunkDraft[];
  apiOperations?: StructuredApiOperation[];
  apiSchemas?: StructuredApiSchema[];
  codeSymbols?: CodeSymbolDraft[];
  abbreviations?: { chunkOrd: number; abbr: string; expansion: string }[];
  warnings: string[];
}

export const CHUNKER_VERSION = "2026.10.1";

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
