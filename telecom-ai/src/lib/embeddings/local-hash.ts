import { extractIdentifiers } from "../telecom/identifiers";

/**
 * Deterministic, offline "feature hashing" embeddings. This is a *lexical* vector model: cosine
 * similarity reflects shared words, identifiers and character trigrams (robust to inflection and
 * typos), not learned semantics. It needs no model download, network, or GPU, and is labelled as
 * such everywhere. Swap in a neural embedding provider via EMBEDDING_PROVIDER for semantic recall.
 */

export const LOCAL_HASH_VERSION = "lh-1";

const STOP = new Set(
  "a an and are as at be but by can for from has have how if in into is it its not of on or such that the their then there these this to was were what when where which while who why will with does do did shall should may might must also any each other than via per".split(" "),
);

function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function tokenize(text: string): string[] {
  const words: string[] = [];
  for (const raw of text.match(/[A-Za-z0-9][A-Za-z0-9_\-.]*[A-Za-z0-9]|[A-Za-z0-9]/g) ?? []) {
    const w = raw.toLowerCase();
    if (STOP.has(w)) continue;
    words.push(w);
    // Split camelCase / snake_case / hyphenated tokens into their parts as well.
    const parts = raw
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .split(/[\s_\-.]+/)
      .map((p) => p.toLowerCase())
      .filter((p) => p.length > 1 && !STOP.has(p));
    if (parts.length > 1) words.push(...parts);
  }
  return words;
}

function stem(w: string): string {
  if (w.length <= 4 || /\d/.test(w)) return w;
  return w.replace(/(ations?|ments?|ings?|ies|ed|es|s)$/, "");
}

export function localHashEmbed(text: string, dims: number): number[] {
  const v = new Float64Array(dims);
  const add = (feature: string, weight: number) => {
    const h = fnv1a(feature);
    const idx = h % dims;
    v[idx]! += (h & 0x80000000 ? -1 : 1) * weight;
  };
  const tf = new Map<string, number>();
  for (const w of tokenize(text)) tf.set(stem(w), (tf.get(stem(w)) ?? 0) + 1);
  for (const [w, n] of tf) {
    const weight = 1 + Math.log(n);
    add(`w:${w}`, weight);
    if (w.length >= 5 && !/\d/.test(w)) {
      const padded = `^${w}$`;
      for (let i = 0; i + 3 <= padded.length; i++) add(`g:${padded.slice(i, i + 3)}`, 0.25 * weight);
    }
  }
  const words = [...tf.keys()];
  for (let i = 0; i + 1 < words.length && i < 400; i++) add(`b:${words[i]}_${words[i + 1]}`, 0.5);
  for (const id of extractIdentifiers(text)) add(`id:${id}`, 2.5);
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  return Array.from(v, (x) => x / norm);
}
