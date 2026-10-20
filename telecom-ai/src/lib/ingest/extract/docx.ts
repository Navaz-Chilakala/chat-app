import mammoth from "mammoth";
import * as cheerio from "cheerio";
import type { Block, ExtractedDocument } from "../types";
import { tableToRows } from "./html";
import { ocrConfig, ocrImage } from "../ocr";

// 3GPP Word templates use Heading 1-9 plus custom paragraph styles:
// TH = table heading, TF = figure caption, NO = note, EX/EW = definition/abbreviation lists,
// PL = program listing, B1..B5 = bullets, TAH/TAC/TAL = table cells, TT = cover title.
const STYLE_MAP = [
  ...[1, 2, 3, 4, 5, 6].map((n) => `p[style-name='Heading ${n}'] => h${n}:fresh`),
  "p[style-name='Heading 7'] => h6.h7:fresh",
  "p[style-name='Heading 8'] => h1.h8:fresh", // 3GPP uses Heading 8/9 for annex titles
  "p[style-name='Heading 9'] => h1.h9:fresh",
  "p[style-name='TH'] => p.th:fresh",
  "p[style-name='TF'] => p.tf:fresh",
  "p[style-name='NO'] => p.note:fresh",
  "p[style-name='NW'] => p.note:fresh",
  "p[style-name='EX'] => p.ex:fresh",
  "p[style-name='EW'] => p.ex:fresh",
  "p[style-name='PL'] => pre.pl:separator('\\n')",
  "p[style-name='B1'] => p.li:fresh",
  "p[style-name='B2'] => p.li:fresh",
  "p[style-name='B3'] => p.li:fresh",
  "p[style-name='B4'] => p.li:fresh",
  "p[style-name='B5'] => p.li:fresh",
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `p[style-name='toc ${n}'] => !`),
  "p[style-name='TT'] => p.cover:fresh",
  "p[style-name='ZA'] => p.cover:fresh",
  "p[style-name='ZB'] => p.cover:fresh",
  "p[style-name='ZT'] => p.cover:fresh",
];

export async function extractDocx(buf: Buffer): Promise<ExtractedDocument> {
  const warnings: string[] = [];
  const cfg = ocrConfig();
  const images: { buf: Buffer | null; contentType: string }[] = [];
  const result = await mammoth.convertToHtml(
    { buffer: buf },
    {
      styleMap: STYLE_MAP,
      includeDefaultStyleMap: true,
      // Figures are kept as positional placeholders; raster ones are OCR'd below when enabled.
      convertImage: mammoth.images.imgElement(async (image) => {
        const id = images.length;
        const wantOcr = cfg.enabled && cfg.figures && id < cfg.maxImagesPerDocument;
        images.push({ buf: wantOcr ? Buffer.from(await image.read()) : null, contentType: image.contentType ?? "" });
        return { src: `figure:${id}` };
      }),
    },
  );
  const unknownStyles = new Set<string>();
  for (const m of result.messages) {
    const s = /Unrecognised paragraph style: '([^']+)'/.exec(m.message);
    if (s) unknownStyles.add(s[1]!);
  }
  const $ = cheerio.load(result.value);
  $("br").replaceWith("\n");
  const blocks: Block[] = [];
  $("body")
    .children()
    .each((_, el) => {
      const node = $(el);
      const tag = el.tagName?.toLowerCase();
      const text = node.text().replace(/ /g, " ").replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").trim();
      if (/^h[1-6]$/.test(tag ?? "")) {
        if (!text) return;
        const cls = node.attr("class") ?? "";
        const level = cls.includes("h7") ? 7 : cls.includes("h8") || cls.includes("h9") ? 1 : Number(tag!.slice(1));
        blocks.push({ type: "heading", text, level });
      } else if (tag === "table") {
        const rows = tableToRows($, node);
        if (rows.length) blocks.push({ type: "table", text: rows.map((r) => r.join(" | ")).join("\n"), rows });
      } else if (tag === "pre") {
        if (text) blocks.push({ type: "code", text: node.text().trim() });
      } else if (tag === "ul" || tag === "ol") {
        node.children("li").each((__, li) => {
          const t = $(li).text().replace(/\s+/g, " ").trim();
          if (t) blocks.push({ type: "list", text: t });
        });
      } else if (tag === "p") {
        const imgs = node.find("img");
        imgs.each((__, img) => {
          const id = /^figure:(\d+)$/.exec($(img).attr("src") ?? "")?.[1];
          if (id !== undefined) blocks.push({ type: "figure", text: "", style: `figure:${id}` });
        });
        if (!text) return;
        const cls = node.attr("class") ?? "";
        if (cls.includes("th") || cls.includes("tf")) blocks.push({ type: "caption", text, style: cls });
        else if (cls.includes("note")) blocks.push({ type: "note", text });
        else if (cls.includes("li")) blocks.push({ type: "list", text });
        else blocks.push({ type: "para", text, style: cls || undefined });
      }
    });
  const ocrStats = { images: images.length, recognised: 0, lowConfidence: 0, skippedUnsupported: 0 };
  for (const block of blocks) {
    if (block.type !== "figure") continue;
    const img = images[Number(block.style!.slice(7))];
    if (!img?.buf) continue;
    if (!/image\/(png|jpe?g|gif|bmp|tiff?|webp)/i.test(img.contentType)) {
      ocrStats.skippedUnsupported++;
      continue;
    }
    const r = await ocrImage(img.buf, { kind: "figure" });
    img.buf = null; // release memory as we go
    if (!r) continue;
    block.text = r.text;
    block.ocr = { confidence: r.confidence, lowConfidence: r.lowConfidence };
    ocrStats.recognised++;
    if (r.lowConfidence) ocrStats.lowConfidence++;
  }
  const figureBlocks = blocks.filter((b) => b.type === "figure");
  const kept = blocks.filter((b) => b.type !== "figure" || b.text);
  blocks.length = 0;
  blocks.push(...kept);
  if (images.length) {
    if (!cfg.enabled || !cfg.figures) warnings.push(`${images.length} embedded figure(s) not OCR'd (OCR disabled); captions and surrounding text are indexed.`);
    else
      warnings.push(
        `Figures: ${images.length} embedded, ${ocrStats.recognised} with OCR text (${ocrStats.lowConfidence} low-confidence), ${ocrStats.skippedUnsupported} vector/unsupported format (EMF/WMF) not OCR'd, ${figureBlocks.length - ocrStats.recognised - ocrStats.skippedUnsupported} without readable text.`,
      );
  }
  if (unknownStyles.size > 20) warnings.push(`${unknownStyles.size} unrecognised Word styles mapped to plain paragraphs.`);
  const head = blocks
    .slice(0, 80)
    .map((b) => b.text)
    .join("\n");
  return { blocks, pageCount: null, warnings, head, format: "docx", ocrStats };
}
