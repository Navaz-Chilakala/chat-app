import { describe, expect, it } from "vitest";
import { isPublicAddress, validateUrlShape, safeFetch } from "@/lib/security/ssrf";
import { parseRobots } from "@/lib/sources/robots";
import { parseDirectoryListing } from "@/lib/sources/threegpp";
import { validateOpenApi, validateInstance } from "@/lib/openapi/validate";
import fs from "node:fs";
import path from "node:path";

describe("SSRF protection", () => {
  it("classifies private, loopback, link-local, metadata and mapped addresses as non-public", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "::ffff:127.0.0.1", "0.0.0.0"]) expect(isPublicAddress(ip), ip).toBe(false);
    expect(isPublicAddress("8.8.8.8")).toBe(true);
  });
  it("rejects bad schemes, credentials, ports, internal names and non-allowlisted hosts", () => {
    expect(() => validateUrlShape("file:///etc/passwd")).toThrow();
    expect(() => validateUrlShape("http://user:pw@example.com/")).toThrow();
    expect(() => validateUrlShape("http://example.com:8080/")).toThrow();
    expect(() => validateUrlShape("http://localhost/")).toThrow();
    expect(() => validateUrlShape("http://metadata.google.internal/")).toThrow();
    expect(() => validateUrlShape("http://169.254.169.254/latest/meta-data/")).toThrow();
    expect(() => validateUrlShape("http://[::1]/")).toThrow();
    expect(() => validateUrlShape("https://evil.com/", { allowedHosts: [".3gpp.org"] })).toThrow(/allowlist/);
    expect(validateUrlShape("https://www.3gpp.org/ftp/", { allowedHosts: [".3gpp.org"] }).hostname).toBe("www.3gpp.org");
  });
  it("refuses to fetch loopback even via an explicit IP", async () => {
    await expect(safeFetch("http://127.0.0.1:80/", { maxBytes: 1000 })).rejects.toThrow();
  });
});

describe("robots.txt and 3GPP listing parsing", () => {
  it("applies the * group with longest-match precedence", () => {
    const rules = parseRobots("User-agent: *\nDisallow: /private\nAllow: /private/public\n\nUser-agent: OtherBot\nDisallow: /");
    expect(rules).toEqual([{ allow: false, path: "/private" }, { allow: true, path: "/private/public" }]);
  });
  it("parses directory listings into direct children only", () => {
    const html = `<html><body><pre><a href="/ftp/Specs/archive/23_series/">[To Parent Directory]</a><br>
      <a href="/ftp/Specs/archive/23_series/23.502/">23.502</a><br>
      <a href="https://www.3gpp.org/ftp/Specs/archive/23_series/23.501/">23.501</a><br>
      <a href="23.401/">23.401</a> <a href="/ftp/Specs/archive/23_series/23.502/23502-j40.zip">deep</a>
      <a href="https://evil.example/23.999/">x</a></pre></body></html>`;
    const entries = parseDirectoryListing(html, "https://www.3gpp.org/ftp/Specs/archive/23_series/");
    expect(entries.map((e) => e.name).sort()).toEqual(["23.401", "23.501", "23.502"]);
    expect(entries.every((e) => e.isDir)).toBe(true);
  });
});

describe("OpenAPI validators", () => {
  const doc = fs.readFileSync(path.join(__dirname, "fixtures/nrf-mini.yaml"), "utf8");
  it("accepts the fixture and reports external refs as warnings", () => {
    const r = validateOpenApi(doc);
    expect(r.errors).toEqual([]);
    expect(r.valid).toBe(true);
    expect(r.warnings.join(" ")).toMatch(/external \$ref/);
  });
  it("detects undeclared path parameters, duplicate operationIds and dangling refs", () => {
    const bad = `openapi: 3.0.0\ninfo: {title: x, version: '1'}\npaths:\n  /a/{id}:\n    get:\n      operationId: dup\n      responses: {'200': {description: ok, content: {application/json: {schema: {$ref: '#/components/schemas/Missing'}}}}}\n  /b:\n    get:\n      operationId: dup\n      responses: {}\n`;
    const r = validateOpenApi(bad);
    expect(r.valid).toBe(false);
    expect(r.errors.join("\n")).toMatch(/path parameter \{id\} is not declared/);
    expect(r.errors.join("\n")).toMatch(/Duplicate operationId 'dup'/);
    expect(r.errors.join("\n")).toMatch(/Unresolved \$ref #\/components\/schemas\/Missing/);
    expect(r.errors.join("\n")).toMatch(/at least one response/);
  });
  it("validates payloads against component schemas", () => {
    expect(validateInstance(doc, "NFProfile", { nfInstanceId: "a", nfType: "AMF", nfStatus: "REGISTERED" }).valid).toBe(true);
    const r = validateInstance(doc, "NFProfile", { nfInstanceId: "a", nfType: "MME" });
    expect(r.valid).toBe(false);
    expect(r.errors.join(" ")).toMatch(/nfStatus|allowed values/);
  });
});
