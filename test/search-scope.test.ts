import { describe, expect, it } from "vitest";
import { buildIndex, buildProject } from "../src/index.js";
import type { ResultEnvelope, SearchSymbolsOutput } from "../src/schemas.js";
import { createTools } from "../src/tools.js";
import { makeTempProject } from "./helpers.js";

const CRYPTO_TS = [
  "export function encryptToken(t: string): string {",
  "  return t;",
  "}",
  "export function decryptToken(t: string): string {",
  "  return t;",
  "}",
  "",
].join("\n");

const FILES: Record<string, string> = {
  "app/utils/crypto.server.ts": CRYPTO_TS,
  "app/utils/helper.ts":
    "export function utilHelper(): void {\n  return;\n}\n",
  "app/utils/sub/deep.ts":
    'export function deepToken(): string {\n  return "";\n}\n',
  // A sibling directory whose name shares the "utils" prefix: "app/utils"
  // must never match this at a path-segment boundary.
  "app/utilsX/other.ts":
    'export function otherToken(): string {\n  return "";\n}\n',
  "app/index.ts": "export function appEntry(): void {\n  return;\n}\n",
};

function buildTools(): ReturnType<typeof createTools> {
  const dir = makeTempProject(FILES);
  return createTools(buildIndex(buildProject(dir)));
}

function okData(env: ResultEnvelope): SearchSymbolsOutput {
  if (!env.ok) {
    throw new Error(`expected ok envelope, got ${JSON.stringify(env)}`);
  }
  return env.data as SearchSymbolsOutput;
}

function names(env: ResultEnvelope): string[] {
  return okData(env).results.map((r) => r.name);
}

describe("search_symbols file scope", () => {
  const tools = buildTools();

  it("matches one file exactly", () => {
    const data = okData(
      tools.search_symbols({ query: "token", file: "app/utils/crypto.server.ts" }),
    );
    expect(data.file_filter_matched_files).toBe(1);
    expect(data.results.map((r) => r.file)).toEqual([
      "app/utils/crypto.server.ts",
      "app/utils/crypto.server.ts",
    ]);
  });

  it("matches a directory prefix and reports the files in scope", () => {
    const data = okData(tools.search_symbols({ query: "token", file: "app/utils" }));
    expect(data.file_filter_matched_files).toBe(3);
    expect(data.results.map((r) => r.name)).toEqual([
      "encryptToken",
      "decryptToken",
      "deepToken",
    ]);
  });

  it("stops at path-segment boundaries (utils vs utilsX)", () => {
    const inside = okData(tools.search_symbols({ query: "token", file: "app/utils" }));
    expect(inside.results.every((r) => r.file.startsWith("app/utils/"))).toBe(true);
    expect(inside.results.map((r) => r.name)).not.toContain("otherToken");
    const sibling = okData(tools.search_symbols({ query: "token", file: "app/utilsX" }));
    expect(sibling.file_filter_matched_files).toBe(1);
    expect(sibling.results.map((r) => r.name)).toEqual(["otherToken"]);
  });

  it("distinguishes a path that matched nothing from a term that matched nothing", () => {
    const pathMiss = okData(tools.search_symbols({ query: "token", file: "app/nope" }));
    expect(pathMiss.file_filter_matched_files).toBe(0);
    expect(pathMiss.results).toEqual([]);
    const termMiss = okData(
      tools.search_symbols({ query: "token", file: "app/index.ts" }),
    );
    expect(termMiss.file_filter_matched_files).toBe(1);
    expect(termMiss.results).toEqual([]);
    // A value that names neither an indexed file nor a directory prefix is
    // simply empty scope: no extension guessing, no globs.
    const bareStem = okData(tools.search_symbols({ query: "token", file: "app/index" }));
    expect(bareStem.file_filter_matched_files).toBe(0);
    expect(bareStem.results).toEqual([]);
  });

  it("normalizes backslashes, a leading ./ and a trailing slash", () => {
    const slashed = okData(
      tools.search_symbols({
        query: "token",
        file: "app\\utils\\crypto.server.ts",
      }),
    );
    const dotted = okData(
      tools.search_symbols({ query: "token", file: "./app/utils/crypto.server.ts" }),
    );
    expect(slashed.results.map((r) => r.name)).toEqual(["encryptToken", "decryptToken"]);
    expect(dotted.results).toEqual(slashed.results);
    expect(dotted.file_filter_matched_files).toBe(1);
    const trailing = okData(tools.search_symbols({ query: "token", file: "app/utils/" }));
    expect(trailing.file_filter_matched_files).toBe(3);
    expect(trailing.results.map((r) => r.name)).toEqual([
      "encryptToken",
      "decryptToken",
      "deepToken",
    ]);
  });

  it("rejects absolute, .., drive-lettered and empty scopes", () => {
    for (const bad of ["../x", "C:/x", "/abs", "app/../x", "", "   ", "c:\\x"]) {
      const env = tools.search_symbols({ query: "token", file: bad });
      expect(env.ok, JSON.stringify(bad)).toBe(false);
      if (!env.ok) expect(env.error.code).toBe("INVALID_ARGS");
    }
  });

  it("composes with limit and truncation", () => {
    const data = okData(
      tools.search_symbols({ query: "token", file: "app/utils", limit: 1 }),
    );
    expect(data.results).toHaveLength(1);
    expect(data.truncated).toBe(true);
    expect(data.file_filter_matched_files).toBe(3);
  });

  it("omits file_filter_matched_files when file is absent", () => {
    const env = tools.search_symbols({ query: "token" });
    const data = okData(env);
    expect(data.file_filter_matched_files).toBeUndefined();
    expect(JSON.stringify(env)).not.toContain("file_filter_matched_files");
    // No regression: an unscoped search still sees the utilsX symbol.
    expect(data.results.map((r) => r.name)).toContain("otherToken");
  });

  it("lists a file's symbols when the term is omitted, deterministically", () => {
    const first = okData(tools.search_symbols({ file: "app/utils/crypto.server.ts" }));
    expect(first.results.map((r) => r.name)).toEqual([
      "encryptToken",
      "decryptToken",
    ]);
    expect(first.truncated).toBe(false);
    expect(first.file_filter_matched_files).toBe(1);
    // Deterministic: file path, then line.
    const lines = first.results.map((r) => r.line);
    expect([...lines].sort((a, b) => a - b)).toEqual(lines);
    expect(tools.search_symbols({ file: "app/utils/crypto.server.ts" })).toEqual(
      tools.search_symbols({ file: "app/utils/crypto.server.ts" }),
    );
  });

  it("lists scoped symbols under the limit and truncates", () => {
    const data = okData(tools.search_symbols({ file: "app/utils", limit: 2 }));
    expect(data.results).toHaveLength(2);
    expect(data.truncated).toBe(true);
    expect(data.file_filter_matched_files).toBe(3);
    expect(data.results.map((r) => r.name)).toEqual(["encryptToken", "decryptToken"]);
  });

  it("still requires a term when file is absent", () => {
    for (const bad of [{}, { query: "" }, { query: "   " }, { file: "" }]) {
      const env = tools.search_symbols(bad);
      expect(env.ok, JSON.stringify(bad)).toBe(false);
      if (!env.ok) expect(env.error.code).toBe("INVALID_ARGS");
    }
  });
});
