import { extractImages, extractTextItems, getDocumentProxy, renderPageAsImage } from "unpdf";
import type { Block, ExtractedDocument } from "../types";
import { linesToBlocks } from "./plaintext";
import { ocrConfig, ocrImage, rawToPng } from "../ocr";

export async function extractPdf(buf: Buffer): Promise<ExtractedDocument> {
  const warnings: string[] = [];
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const { totalPages, items } = await extractTextItems(pdf);
  const lines: { text: string; page: number; large?: boolean }[] = [];
  const pagesWithoutText: number[] = [];
  const sizes: number[] = [];
  for (const pageItems of items) for (const it of pageItems) if (it.str.trim()) sizes.push(it.fontSize);
  sizes.sort((a, b) => a - b);
  const bodySize = sizes[Math.floor(sizes.length / 2)] ?? 10;

  items.forEach((pageItems, idx) => {
    const page = idx + 1;
    const visible = pageItems.filter((i) => i.str.trim());
    if (!visible.length) {
      pagesWithoutText.push(page);
      return;
    }
    // Group items into lines by y coordinate (PDF origin is bottom-left: sort descending).
    const sorted = [...visible].sort((a, b) => b.y - a.y || a.x - b.x);
    let current: typeof sorted = [];
    let currentY = sorted[0]!.y;
    const emit = () => {
      if (!current.length) return;
      current.sort((a, b) => a.x - b.x);
      let text = "";
      let lastEnd = -Infinity;
      for (const it of current) {
        if (text && it.x - lastEnd > 1.5) text += " ";
        text += it.str;
        lastEnd = it.x + it.width;
      }
      const maxSize = Math.max(...current.map((c) => c.fontSize));
      lines.push({ text, page, large: maxSize >= bodySize * 1.35 });
      current = [];
    };
    for (const it of sorted) {
      if (Math.abs(it.y - currentY) > Math.max(2, it.fontSize * 0.4)) {
        emit();
        currentY = it.y;
        // A vertical gap larger than ~1.6 lines starts a new paragraph.
      }
      current.push(it);
    }
    emit();
    lines.push({ text: "", page });
  });

  // OCR: scanned pages get full-page recognition at ~300 DPI; raster figures on text pages get figure OCR.
  const cfg = ocrConfig();
  const ocrPages: Record<number, number> = {};
  const figureBlocks: Block[] = [];
  const ocrStats = { images: 0, recognised: 0, lowConfidence: 0, skippedUnsupported: 0 };
  if (cfg.enabled) {
    for (const page of pagesWithoutText) {
      const png = Buffer.from(await renderPageAsImage(pdf, page, { scale: 300 / 72, canvasImport: () => import("@napi-rs/canvas") }));
      const r = await ocrImage(png, { alreadyPrepared: true, kind: "page" });
      if (!r) continue;
      ocrPages[page] = r.confidence;
      for (const t of r.text.split("\n")) lines.push({ text: t, page });
      lines.push({ text: "", page });
    }
    if (cfg.figures) {
      for (let page = 1; page <= totalPages; page++) {
        if (ocrStats.images >= cfg.maxImagesPerDocument) break;
        if (ocrPages[page] !== undefined) continue;
        const imgs = await extractImages(pdf, page).catch(() => []);
        for (const img of imgs) {
          if (img.width < 150 || img.height < 80) continue;
          ocrStats.images++;
          const r = await ocrImage(await rawToPng(img.data, img.width, img.height, img.channels), { kind: "figure" });
          if (!r) continue;
          ocrStats.recognised++;
          if (r.lowConfidence) ocrStats.lowConfidence++;
          figureBlocks.push({ type: "figure", text: r.text, page, ocr: { confidence: r.confidence, lowConfidence: r.lowConfidence } });
        }
      }
    }
    lines.sort((a, b) => a.page - b.page); // keep OCR'd page text in reading order
  }

  // Drop running headers/footers: identical short lines repeated on many pages.
  const freq = new Map<string, number>();
  for (const l of lines) if (l.text && l.text.length < 80) freq.set(l.text, (freq.get(l.text) ?? 0) + 1);
  const repeated = new Set([...freq].filter(([, n]) => n >= Math.max(3, totalPages * 0.5)).map(([t]) => t));
  const cleaned = lines.filter((l) => !repeated.has(l.text) && !/^\d{1,4}$/.test(l.text.trim()));

  if (pagesWithoutText.length) {
    const done = Object.keys(ocrPages).length;
    const low = Object.values(ocrPages).filter((c) => c < cfg.minConfidence).length;
    warnings.push(
      cfg.enabled
        ? `${pagesWithoutText.length} page(s) had no text layer; ${done} recovered by OCR (${low} below ${cfg.minConfidence}% confidence). OCR text is machine-extracted — verify against the original page.`
        : `OCR disabled: ${pagesWithoutText.length}/${totalPages} page(s) contain no extractable text and are not searchable.`,
    );
  }
  if (ocrStats.images) warnings.push(`Figures: ${ocrStats.images} raster image(s), ${ocrStats.recognised} with OCR text (${ocrStats.lowConfidence} low-confidence).`);
  const blocks = linesToBlocks(cleaned);
  // Insert figure blocks after the last block of their page to keep document order.
  for (const fig of figureBlocks) {
    let idx = -1;
    for (let i = 0; i < blocks.length; i++) if ((blocks[i]!.page ?? 0) <= fig.page!) idx = i;
    blocks.splice(idx + 1, 0, fig);
  }
  const head = cleaned
    .slice(0, 120)
    .map((l) => l.text)
    .join("\n");
  return { blocks, pageCount: totalPages, warnings, head, format: "pdf", ocrPages, ocrStats };
}
