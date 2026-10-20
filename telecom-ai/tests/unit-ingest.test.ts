import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { chunkDocument } from "@/lib/ingest/chunk/document";
import { chunkCode, languageForPath } from "@/lib/ingest/chunk/code";
import { chunkOpenApi, parseStructured } from "@/lib/ingest/chunk/openapi";
import { extractMarkdown, extractPlainText } from "@/lib/ingest/extract/plaintext";
import { extractHtml } from "@/lib/ingest/extract/html";
import { sniffFormat, looksBinary, processFile, unpackSpecZip, mergeExtracted } from "@/lib/ingest/process";
import { zipSync } from "fflate";
import { localHashEmbed } from "@/lib/embeddings/local-hash";
import { packUnits, MAX_TOKENS } from "@/lib/ingest/chunk/common";
import { estimateTokens } from "@/lib/ingest/types";
import { terminateOcr } from "@/lib/ingest/ocr";

const cos = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i]!, 0);

describe("document chunking", () => {
  it("builds the clause hierarchy, heading paths and normative flags from plain text", () => {
    const doc = extractPlainText(["5 Procedures", "5.1 Registration", "The UE shall send a Registration Request to the AMF.", "", "5.1.1 Abnormal cases", "If T3510 expires the UE shall abort the procedure."].join("\n"));
    const r = chunkDocument(doc, { docLabel: "TS 99.000" });
    expect(r.sections.map((s) => s.clause)).toEqual([null, "5", "5.1", "5.1.1"]);
    const c = r.chunks.find((x) => x.clause === "5.1.1")!;
    expect(c.headingPath).toBe("TS 99.000 > 5 Procedures > 5.1 Registration > 5.1.1 Abnormal cases");
    expect(c.flags).toContain("normative");
    expect(c.identifiers).toEqual(expect.arrayContaining(["timer:t3510", "clause:5.1.1"]));
  });
  it("never exceeds the maximum chunk size and overlaps short trailing units", () => {
    const long = Array.from({ length: 80 }, (_, i) => `Sentence number ${i} explains a detail of the procedure in a moderately long way.`).join(" ");
    const pieces = packUnits([long, "Short tail unit.", long]);
    expect(pieces.length).toBeGreaterThan(2);
    for (const p of pieces) expect(estimateTokens(p)).toBeLessThanOrEqual(MAX_TOKENS * 1.6);
  });
  it("chunks markdown and HTML by headings and keeps tables", () => {
    const md = chunkDocument(extractMarkdown("# A\n\ntext a\n\n## B\n\n| x | y |\n|---|---|\n| 1 | 2 |\n"));
    expect(md.chunks.some((c) => c.chunkType === "table" && c.content.includes("| 1 | 2 |"))).toBe(true);
    const html = extractHtml("<html><head><title>T</title><script>alert(1)</script></head><body><article><h1>Intro</h1><p>Hello world paragraph.</p></article></body></html>");
    expect(html.blocks.map((b) => b.type)).toEqual(["heading", "para"]);
    expect(JSON.stringify(html.blocks)).not.toContain("alert");
  });
});

describe("code chunking", () => {
  it("splits C code by function symbols and derives message identifiers from snake_case names", () => {
    const src = ["#include <stdio.h>", "", "/* handle the NGAP Initial UE Message */", "int ngap_handle_initial_ue_message(amf_gnb_t *gnb, ngap_message_t *msg)", "{", "    return 0;", "}", "", "static void other(void)", "{", "}"].join("\n");
    const r = chunkCode(src, { path: "src/amf/ngap-handler.c", repo: "open5gs", commit: "abc" });
    expect(r.codeSymbols?.map((s) => s.name)).toEqual(["ngap_handle_initial_ue_message", "other"]);
    const c = r.chunks.find((x) => x.symbol === "ngap_handle_initial_ue_message")!;
    expect(c.content).toContain("handle the NGAP Initial UE Message");
    expect(c.lineStart).toBe(3);
    expect(c.identifiers).toEqual(expect.arrayContaining(["msg:initialuemessage", "sym:ngap_handle_initial_ue_message"]));
    expect(c.flags).not.toContain("normative");
  });
  it("recognises ASN.1 definitions and language by path", () => {
    const r = chunkCode("InitialUEMessage ::= SEQUENCE {\n  protocolIEs ProtocolIE-Container\n}\n", { path: "NGAP-PDU-Contents.asn" });
    expect(r.codeSymbols?.[0]?.name).toBe("InitialUEMessage");
    expect(languageForPath("x/y.go")).toBe("go");
  });
});

describe("OpenAPI structural parsing", () => {
  const text = fs.readFileSync(path.join(__dirname, "fixtures/nrf-mini.yaml"), "utf8");
  const r = chunkOpenApi(parseStructured(text) as Record<string, unknown>, "nrf-mini.yaml");
  it("extracts operations with path-level parameters, responses and security", () => {
    expect(r.apiOperations?.map((o) => `${o.method} ${o.operationId}`)).toEqual(["GET GetNFInstance", "PUT RegisterNFInstance"]);
    const put = r.apiOperations!.find((o) => o.method === "PUT")!;
    expect(put.parameters.map((p) => (p as { name: string }).name)).toEqual(["nfInstanceID"]);
    expect(Object.keys(put.responses)).toEqual(["201", "400", "404"]);
    const chunk = r.chunks.find((c) => c.symbol === "RegisterNFInstance")!;
    expect(chunk.content).toContain("ProblemDetails (external: TS29571_CommonData.yaml)");
    expect(chunk.identifiers).toEqual(expect.arrayContaining(["op:registernfinstance", "path:/nf-instances/{nfinstanceid}", "http:404", "spec:29.510"]));
  });
  it("extracts schemas with required fields", () => {
    expect(r.apiSchemas?.find((s) => s.name === "NFProfile")?.required).toEqual(["nfInstanceId", "nfType", "nfStatus"]);
  });
});

describe("format detection and embeddings", () => {
  it("sniffs formats by magic bytes, not just extension", async () => {
    expect(sniffFormat(Buffer.from("%PDF-1.7 ..."), "x.txt")).toBe("pdf");
    expect(sniffFormat(fs.readFileSync(path.join(__dirname, "fixtures/nrf-mini.yaml")), "a.yaml")).toBe("openapi");
    expect(looksBinary(Buffer.from([0, 1, 2, 0, 0, 3, 4]))).toBe(true);
    await expect(processFile(Buffer.from([0, 0, 0, 1, 2, 3, 0, 0]), "evil.txt")).rejects.toThrow(/binary/);
  });
  it("local-hash embeddings are deterministic, normalised and lexically meaningful", () => {
    const a = localHashEmbed("PDU session establishment request sent by the UE", 384);
    const b = localHashEmbed("The UE sends a PDU Session Establishment Request", 384);
    const c = localHashEmbed("Diameter accounting answer from the charging function", 384);
    expect(a).toEqual(localHashEmbed("PDU session establishment request sent by the UE", 384));
    expect(Math.abs(cos(a, a) - 1)).toBeLessThan(1e-9);
    expect(cos(a, b)).toBeGreaterThan(cos(a, c) + 0.2);
  });
});

describe("OCR", () => {
  it("recovers all labels of an embedded figure in the synthetic 3GPP-styled DOCX", async () => {
    const out = await processFile(fs.readFileSync(path.join(__dirname, "fixtures/synthetic-spec.docx")), "synthetic-spec.docx");
    const fig = out.result.chunks.find((c) => c.chunkType === "figure_ocr")!;
    expect(fig.content).toContain("Figure 4.2-1: Synthetic Widget Attach sequence");
    for (const m of ["Registration Request", "Authentication Request", "Authentication Response"]) expect(fig.content).toContain(m);
    expect(fig.flags).toContain("ocr");
    await terminateOcr();
  }, 120_000);
});

describe("multi-part 3GPP deliverables", () => {
  it("returns every document part in natural clause order and skips other files", () => {
    const docx = new Uint8Array(fs.readFileSync(path.join(__dirname, "fixtures/synthetic-spec.docx")));
    const zip = Buffer.from(zipSync({
      "24501-k10_s10-s11.docx": docx,
      "24501-k10_s00-s0805.docx": docx,
      "24501-k10_s0806-s09.docx": docx,
      "readme.txt": new TextEncoder().encode("x"),
    }));
    const { parts, others } = unpackSpecZip(zip);
    expect(parts.map((p) => p.name)).toEqual(["24501-k10_s00-s0805.docx", "24501-k10_s0806-s09.docx", "24501-k10_s10-s11.docx"]);
    expect(others).toEqual(["readme.txt"]);
  });

  it("merges parts with monotonic page numbers and the first part's cover", () => {
    const merged = mergeExtracted([
      { blocks: [{ type: "para", text: "cover", page: 1 }], pageCount: 3, warnings: ["w"], head: "COVER", format: "pdf", ocrPages: { 2: 80 } },
      { blocks: [{ type: "para", text: "T3510 start", page: 1 }], pageCount: 2, warnings: ["w"], head: "PART2", format: "pdf" },
    ]);
    expect(merged.blocks.map((b) => [b.text, b.page])).toEqual([["cover", 1], ["T3510 start", 4]]);
    expect(merged.pageCount).toBe(5);
    expect(merged.head).toBe("COVER");
    expect(merged.warnings).toEqual(["w"]);
    expect(merged.ocrPages).toEqual({ 2: 80 });
  });

  it("indexes the content of all parts, not only the largest file", async () => {
    const docx = fs.readFileSync(path.join(__dirname, "fixtures/synthetic-spec.docx"));
    const single = await processFile(docx, "synthetic-spec.docx");
    const zip = Buffer.from(zipSync({ "99999-k10_s00-s05.docx": new Uint8Array(docx), "99999-k10_s06-s10.docx": new Uint8Array(docx) }));
    const multi = await processFile(zip, "99999-k10.zip");
    expect(multi.format).toBe("docx");
    expect(multi.innerFilename).toBe("99999-k10_s00-s05.docx + 99999-k10_s06-s10.docx");
    expect(multi.result.chunks.length).toBeGreaterThan(single.result.chunks.length * 1.5);
  }, 240_000);
});
