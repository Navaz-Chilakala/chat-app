import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import ts from "typescript";
import { chunkOpenApi, parseStructured } from "@/lib/ingest/chunk/openapi";
import { generate, type GenInput } from "@/lib/openapi/codegen";
import { renderMermaid, sanitizeParticipant } from "@/lib/flows/build";

const doc = parseStructured(fs.readFileSync(path.join(__dirname, "fixtures/nrf-mini.yaml"), "utf8")) as Record<string, unknown>;
const parsed = chunkOpenApi(doc, "nrf-mini.yaml");
const input: GenInput = {
  apiTitle: parsed.apiOperations![0]!.apiTitle,
  apiVersion: "1.0.0-test",
  specRefs: ["3GPP TS 29.510"],
  sourceLabel: "nrf-mini.yaml",
  operations: parsed.apiOperations!.map((o) => ({ method: o.method, path: o.path, operationId: o.operationId, summary: o.summary, parameters: o.parameters as Record<string, unknown>[], requestBody: o.requestBody as Record<string, unknown> | null, responses: o.responses })),
  schemas: parsed.apiSchemas!.map((s) => ({ name: s.name, schema: s.schema as Record<string, unknown> })),
};

describe("deterministic code generation", () => {
  it("generates a TypeScript client that type-checks under strict mode", () => {
    const files = generate(input, "typescript-client");
    const client = files.find((f) => f.path === "client.ts")!.content;
    expect(client).toContain("async registerNFInstance(params:");
    expect(client).toContain("Missing required path parameter 'nfInstanceID'");
    expect(client).toContain("encodeURIComponent");
    expect(generate(input, "typescript-client")[0]!.content).toBe(client); // reproducible
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gen-"));
    const file = path.join(dir, "client.ts");
    fs.writeFileSync(file, client);
    const program = ts.createProgram([file], { strict: true, noEmit: true, target: ts.ScriptTarget.ES2022, lib: ["lib.es2022.d.ts", "lib.dom.d.ts"], types: [] });
    const diags = ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
    expect(diags).toEqual([]);
  });
  it("generates Python client and FastAPI stub that compile", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "genpy-"));
    for (const target of ["python-client", "python-fastapi"] as const) {
      for (const f of generate(input, target).filter((x) => x.path.endsWith(".py"))) {
        const p = path.join(dir, `${target}-${f.path}`);
        fs.writeFileSync(p, f.content);
        execFileSync("python3", ["-m", "py_compile", p]);
      }
    }
    const py = generate(input, "python-client")[0]!.content;
    expect(py).toContain("def register_nf_instance(self, nf_instance_id: str, body: NFProfile");
    expect(py).toContain("quote(str(nf_instance_id), safe='')");
  });
  it("generates Go structs with required/omitempty tags", () => {
    const go = generate(input, "go-structs")[0]!.content;
    expect(go).toContain('NfInstanceId string `json:"nfInstanceId"`');
    expect(go).toContain('HeartBeatTimer int64 `json:"heartBeatTimer,omitempty"`');
  });
});

describe("mermaid rendering", () => {
  it("sanitises participants and labels and wraps conditional steps", () => {
    const m = renderMermaid([
      { label: "1", from: "UE", to: "(R)AN", message: "AN message (AN parameters; Registration Request)" },
      { label: "2", from: "(R)AN", to: "new AMF", message: "N2 message", optional: true, condition: "if AMF changed" },
    ]);
    expect(m).toContain("participant R_AN as (R)AN");
    expect(m).toContain("UE->>R_AN: AN message (AN parameters, Registration Request)");
    expect(m).toMatch(/opt if AMF changed\n\s+R_AN->>new_AMF: N2 message\n\s+end/);
    expect(sanitizeParticipant("S-GW")).toBe("S_GW");
  });
});
