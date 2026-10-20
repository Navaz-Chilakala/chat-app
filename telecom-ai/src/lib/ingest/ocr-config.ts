/** OCR settings (separate module so web routes can read them without loading Tesseract). */
export interface OcrConfig {
  enabled: boolean;
  figures: boolean;
  minConfidence: number;
  model: "best" | "fast";
  maxImagesPerDocument: number;
}

export function ocrConfig(): OcrConfig {
  const e = process.env;
  return {
    enabled: e.OCR_ENABLED !== "false",
    figures: e.OCR_FIGURES !== "false",
    minConfidence: Number(e.OCR_MIN_CONFIDENCE ?? 60),
    model: e.OCR_MODEL === "fast" ? "fast" : "best",
    maxImagesPerDocument: Number(e.OCR_MAX_IMAGES_PER_DOC ?? 2000),
  };
}
