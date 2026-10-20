/** 3GPP specification numbering, version and release helpers. */

const ALNUM = "0123456789abcdefghijklmnopqrstuvwxyz";

/** Decode the 3-character 3GPP version code ("j40" -> "19.4.0"). Returns null if not decodable. */
export function decodeVersionCode(code: string): string | null {
  const c = code.toLowerCase();
  if (/^[0-9a-z]{3}$/.test(c)) {
    return [...c].map((ch) => String(ALNUM.indexOf(ch))).join(".");
  }
  // Six-digit form used when a field exceeds 35 (e.g. "190400" -> 19.4.0).
  if (/^\d{6}$/.test(c)) return `${Number(c.slice(0, 2))}.${Number(c.slice(2, 4))}.${Number(c.slice(4, 6))}`;
  return null;
}

export interface SpecFileInfo {
  specNumber: string; // "23.502" or "36.523-1"
  series: string; // "23"
  version: string; // "19.4.0"
  release: number | null; // major version >= 3 maps to the release of the same number
}

/** Parse archive filenames such as `23502-j40.zip`, `36523-1-h00.zip`, `38331-190400.zip`. */
export function parseSpecFilename(filename: string): SpecFileInfo | null {
  const base = filename.split("/").pop() ?? filename;
  const m = /^(\d{2})(\d{3})(?:-(\d{1,2}))?-([0-9a-z]{3}|\d{6})\.(zip|docx?|pdf)$/i.exec(base);
  if (!m) return null;
  const version = decodeVersionCode(m[4]!);
  if (!version) return null;
  const major = Number(version.split(".")[0]);
  return {
    specNumber: `${m[1]}.${m[2]}${m[3] ? `-${m[3]}` : ""}`,
    series: m[1]!,
    version,
    release: major >= 3 ? major : null,
  };
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * 3GPP numbering convention: xx.8xx and xx.9xx are Technical Reports, others Technical Specifications.
 * This is only a fallback; the cover page ("3GPP TS 23.502 V19.4.0") is authoritative when present.
 */
export function inferSpecType(specNumber: string): "TS" | "TR" {
  const third = specNumber.split(".")[1]?.[0];
  return third === "8" || third === "9" ? "TR" : "TS";
}

export interface CoverInfo {
  specType: "TS" | "TR";
  specNumber: string;
  version: string;
  date: string | null; // "2025-06"
  title: string | null;
  release: number | null;
}

/** Parse the cover block of a 3GPP deliverable from its first ~3000 characters of text. */
export function parseCover(text: string): CoverInfo | null {
  const head = text.slice(0, 8000);
  const m = /3GPP\s+(TS|TR)\s+(\d{2}\.\d{3}(?:-\d+)?)\s+V(\d+\.\d+\.\d+)\s*(?:\((\d{4}-\d{2})\))?/.exec(head);
  if (!m) return null;
  const rel = /Release\s+(\d{1,2})\b/.exec(head);
  // Title: the text between "Technical Specification Group <name>;" and "(Release NN)". The group name ends at
  // the first ";" or line break, so covers laid out as one run of text (e.g. inside a table) also parse.
  let title: string | null = null;
  const t = /Technical Specification Group[^;\n]*(?:;|\n)([\s\S]{5,600}?)\(Release\s+\d+\)/.exec(head.slice(m.index));
  if (t) {
    title = t[1]!
      .split(/\n| \| /)
      .map((l) => l.trim())
      .filter((l) => l && !/^Technical Specification Group/.test(l) && !/^3GPP\b/.test(l))
      .join(" ")
      .replace(/\s+/g, " ")
      .replace(/^[;\s]+|[;\s]+$/g, "")
      .trim();
  }
  return {
    specType: m[1] as "TS" | "TR",
    specNumber: m[2]!,
    version: m[3]!,
    date: m[4] ?? null,
    title: title || null,
    release: rel ? Number(rel[1]) : null,
  };
}

/** Domain tags used for UI filters (LTE/EPC, 5GC, RAN, security, protocols, IMS, charging, testing). */
export function tagsForSpec(specNumber: string | null, title = ""): string[] {
  const tags = new Set<string>();
  const t = title.toLowerCase();
  if (specNumber) {
    const [series, rest = ""] = specNumber.split(".");
    const n = Number(rest.slice(0, 3));
    if (series === "38") tags.add("ran").add("5g");
    if (series === "36") tags.add("ran").add("lte");
    if (series === "33") tags.add("security");
    if (series === "32" || specNumber.startsWith("32.")) tags.add("charging-oam");
    if (series === "34" || series === "37" && n >= 500) tags.add("testing");
    if (series === "24" || series === "29") tags.add("protocols");
    if (series === "29" && n >= 500 && n < 600) tags.add("5gc").add("sbi");
    if (["23.501", "23.502", "23.503", "24.501", "38.413", "29.244"].includes(specNumber)) tags.add("5gc");
    if (["23.401", "23.402", "24.301", "29.274", "29.281", "36.413", "29.272", "29.212"].includes(specNumber)) tags.add("lte");
    if (["23.228", "24.229"].includes(specNumber)) tags.add("ims");
  }
  if (/\b5g\b|\bnr\b|5gs|ng-ran|next generation/.test(t)) tags.add("5g");
  if (/e-utra|\beps\b|\bepc\b|\blte\b/.test(t)) tags.add("lte");
  if (/security|authentication/.test(t)) tags.add("security");
  if (/\bims\b|ip multimedia/.test(t)) tags.add("ims");
  if (/charging/.test(t)) tags.add("charging-oam");
  if (tags.has("5g") && (t.includes("core") || t.includes("system architecture"))) tags.add("5gc");
  return [...tags];
}
