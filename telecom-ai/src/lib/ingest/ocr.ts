import path from "node:path";
import { createRequire } from "node:module";
import type { Worker } from "tesseract.js";
import { logger } from "../logger";
import { ocrConfig } from "./ocr-config";

export { ocrConfig, type OcrConfig } from "./ocr-config";

/**
 * OCR via Tesseract (WASM, runs locally; no LLM, no network). Uses the bundled "best" English model
 * because accuracy matters more than speed for standards text. OCR output is always labelled as
 * machine-extracted and its confidence is stored so retrieval can down-rank weak recognitions.
 */

export interface OcrResult {
  text: string;
  confidence: number; // 0-100, Tesseract mean word confidence
  lowConfidence: boolean;
}

let workerPromise: Promise<Worker> | null = null;
let queue: Promise<unknown> = Promise.resolve();

function langPath(model: "best" | "fast"): string {
  const require = createRequire(import.meta.url);
  const pkgDir = path.dirname(require.resolve("@tesseract.js-data/eng/package.json"));
  return path.join(pkgDir, model === "best" ? "4.0.0_best_int" : "4.0.0");
}

async function getWorker(): Promise<Worker> {
  if (!workerPromise) {
    const cfg = ocrConfig();
    workerPromise = (async () => {
      const { createWorker, OEM } = await import("tesseract.js");
      const worker = await createWorker("eng", OEM.LSTM_ONLY, {
        langPath: langPath(cfg.model),
        cacheMethod: "none",
        gzip: true,
      });
      // Preserve spacing inside tables/figures. Resolution is estimated per image (no fixed DPI hint).
      await worker.setParameters({ preserve_interword_spaces: "1" });
      logger.info("ocr.worker_ready", { model: cfg.model });
      return worker;
    })();
  }
  return workerPromise;
}

/** Upscale small images (Tesseract is most accurate at ~30px x-height) and flatten to opaque PNG. */
async function prepareImage(image: Buffer): Promise<Buffer | null> {
  try {
    const { loadImage, createCanvas } = await import("@napi-rs/canvas");
    const img = await loadImage(image);
    if (img.width < 40 || img.height < 20) return null; // icons/bullets
    const scale = img.width < 1200 ? Math.min(3, 1600 / img.width) : 1;
    const w = Math.round(img.width * scale);
    const h = Math.round(img.height * scale);
    const canvas = createCanvas(w, h);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    return canvas.toBuffer("image/png");
  } catch {
    return null; // unsupported format (e.g. EMF/WMF vector figures)
  }
}

/** Convert raw pixel data (from PDF image extraction) to a PNG buffer. */
export async function rawToPng(data: Uint8ClampedArray, width: number, height: number, channels: 1 | 3 | 4): Promise<Buffer> {
  const { createCanvas } = await import("@napi-rs/canvas");
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  const imgData = ctx.createImageData(width, height);
  for (let i = 0, j = 0; i < width * height; i++, j += channels) {
    const o = i * 4;
    if (channels === 1) {
      imgData.data[o] = imgData.data[o + 1] = imgData.data[o + 2] = data[j]!;
      imgData.data[o + 3] = 255;
    } else {
      imgData.data[o] = data[j]!;
      imgData.data[o + 1] = data[j + 1]!;
      imgData.data[o + 2] = data[j + 2]!;
      imgData.data[o + 3] = channels === 4 ? data[j + 3]! : 255;
    }
  }
  ctx.putImageData(imgData, 0, 0);
  return canvas.toBuffer("image/png");
}

function cleanOcrText(raw: string): string {
  return raw
    .split("\n")
    .map((l) => l.replace(/\s+$/g, "").replace(/(?<=\w)\|(?=\s|$)|(?<=\s)\|(?=\w)/g, "")) // diagram lines crossing text
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const alnum = (t: string) => t.replace(/[^A-Za-z0-9]/g, "").length;

/**
 * OCR one image. Calls are serialised through a single worker to bound memory.
 * tesseract.js defaults to PSM 6 (single block), which drops sparse diagram labels, so pages use automatic
 * layout analysis (PSM 3) and figures additionally try sparse-text mode (PSM 11), keeping the better result.
 */
export async function ocrImage(image: Buffer, opts: { alreadyPrepared?: boolean; kind?: "figure" | "page" } = {}): Promise<OcrResult | null> {
  const run = async (): Promise<OcrResult | null> => {
    const prepared = opts.alreadyPrepared ? image : await prepareImage(image);
    if (!prepared) return null;
    const worker = await getWorker();
    const { PSM } = await import("tesseract.js");
    const modes = opts.kind === "page" ? [PSM.AUTO] : [PSM.AUTO, PSM.SPARSE_TEXT];
    let best: { text: string; confidence: number } | null = null;
    for (const mode of modes) {
      await worker.setParameters({ tessedit_pageseg_mode: mode });
      const { data } = await worker.recognize(prepared);
      const cand = { text: cleanOcrText(data.text), confidence: data.confidence };
      // Layout analysis (first mode) keeps words intact; sparse mode wins only if it recovers clearly more text.
      if (!best || (alnum(cand.text) > alnum(best.text) * 1.25 && cand.confidence >= best.confidence - 5)) best = cand;
    }
    if (!best || best.text.replace(/[^A-Za-z0-9]/g, "").length < 3) return null;
    return { text: best.text, confidence: best.confidence, lowConfidence: best.confidence < ocrConfig().minConfidence };
  };
  const p = queue.then(run, run);
  queue = p.catch(() => undefined);
  return p;
}

export async function terminateOcr() {
  if (workerPromise) {
    const w = await workerPromise.catch(() => null);
    workerPromise = null;
    await w?.terminate();
  }
}
