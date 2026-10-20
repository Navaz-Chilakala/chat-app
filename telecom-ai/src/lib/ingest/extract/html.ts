import * as cheerio from "cheerio";
import type { CheerioAPI, Cheerio } from "cheerio";
import type { AnyNode } from "domhandler";
import type { Block, ExtractedDocument } from "../types";

const flat = (s: string) => s.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();

/**
 * A cell's paragraphs, one per line. Concatenating them blindly glues words together
 * ("15s" + "NOTE 7" -> "15sNOTE 7"), which corrupts quotes, identifiers and cover-page parsing.
 */
function cellText($: CheerioAPI, td: Cheerio<AnyNode>): string {
  // Innermost paragraph-like elements only, so a <li> wrapping a <p> is not counted twice.
  const paras = td.find("p, li").filter((_, el) => $(el).find("p, li").length === 0);
  if (!paras.length) return flat(td.text());
  return paras
    .toArray()
    .map((el) => flat($(el).text()))
    .filter(Boolean)
    .join("\n");
}

export function tableToRows($: CheerioAPI, table: Cheerio<AnyNode>): string[][] {
  const rows: string[][] = [];
  table.find("tr").each((_, tr) => {
    const cells: string[] = [];
    $(tr)
      .children("td,th")
      .each((__, td) => {
        cells.push(cellText($, $(td)));
      });
    if (cells.some((c) => c)) rows.push(cells);
  });
  return rows;
}

export function extractHtml(html: string): ExtractedDocument {
  const $ = cheerio.load(html);
  $("script,style,noscript,nav,footer,header,iframe,svg,form").remove();
  const root = $("article").first().length ? $("article").first() : $("main").first().length ? $("main").first() : $("body");
  const blocks: Block[] = [];
  root.find("h1,h2,h3,h4,h5,h6,p,li,pre,table,figcaption,blockquote").each((_, el) => {
    const node = $(el);
    const tag = el.tagName.toLowerCase();
    // Avoid double-counting nested matches (e.g. <p> inside <li> or <table>).
    if (tag !== "table" && node.parents("table").length) return;
    if ((tag === "p" || tag === "pre") && node.parents("li").length) return;
    const text = node.text().replace(/\s+/g, " ").trim();
    if (!text && tag !== "table") return;
    if (/^h[1-6]$/.test(tag)) blocks.push({ type: "heading", text, level: Number(tag[1]) });
    else if (tag === "pre") blocks.push({ type: "code", text: node.text().trim() });
    else if (tag === "li") blocks.push({ type: "list", text });
    else if (tag === "figcaption") blocks.push({ type: "caption", text });
    else if (tag === "table") {
      const rows = tableToRows($, node);
      if (rows.length) blocks.push({ type: "table", text: rows.map((r) => r.join(" | ")).join("\n"), rows });
    } else blocks.push({ type: "para", text });
  });
  const title = $("title").first().text().trim();
  const head = [title, ...blocks.slice(0, 40).map((b) => b.text)].join("\n");
  return { blocks, pageCount: null, warnings: [], head, format: "html" };
}

export function htmlTitle(html: string): string | null {
  const $ = cheerio.load(html);
  return $("title").first().text().trim() || $("h1").first().text().trim() || null;
}
