import WordExtractor from "word-extractor";
import type { ExtractedDocument } from "../types";
import { linesToBlocks } from "./plaintext";

/** Legacy binary Word (.doc), still found in older 3GPP archive zips. No style info: headings are inferred. */
export async function extractDoc(buf: Buffer): Promise<ExtractedDocument> {
  const extractor = new WordExtractor();
  const doc = await extractor.extract(buf);
  const body = doc.getBody();
  const blocks = linesToBlocks(body.split(/\r?\n/).map((text) => ({ text })));
  return {
    blocks,
    pageCount: null,
    warnings: ["Legacy .doc format: heading structure inferred from clause numbering; tables are flattened to text."],
    head: body.slice(0, 4000),
    format: "doc",
  };
}
