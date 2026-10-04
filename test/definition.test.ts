import { describe, expect, it } from "vitest";
import { buildIndex, buildProject, toForwardSlashes } from "../src/index.js";
import type { GetDefinitionOutput, ResultEnvelope } from "../src/schemas.js";
import { GetDefinitionOutputSchema } from "../src/schemas.js";
import { createTools } from "../src/tools.js";
import { makeTempProject } from "./helpers.js";

// Built dynamically so this test source contains no token-shaped literal.
const AKIA_SECRET = "AKIA" + "ABCDEFGH01234567";
const GHP_SECRET = "gh" + "p_" + "abcdefghij".repeat(3);
const SK_SECRET = "sk-" + "abcdefghij".repeat(3);
const B64_SECRET = "QUJDREVGR0hJSktMTU5PUA".repeat(2);
const LONG_ID = "camelCaseIdentifier".padEnd(55, "z");

const B_SRC = `export function helper(n: number): number {
  return n + 1;
}
export const other = 7;
export type T = { id: number };
`;

const C_SRC = `export default function c(): number {
  return 1;
}
`;

const D_SRC = `export const x = 1;
`;

const CRLF_SRC = "export function crlfOne(a: number): number {\r\n  return a;\r\n}\r\n";

const TEST_SRC = `export function testOnly(): number {
  return 1;
}
`;

const LONG_FN = [
  "export function longOne(): number {",
  "  let n = 0;",
  ...Array.from({ length: 98 }, () => "  n += 1;"),
  "  return n;",
  "}",
].join("\n");

const FILLER = "filler word ".repeat(1660);

const A_SRC = [
  'import { helper, other, T } from "./b";',
  'import c from "./c";',
  'import * as d from "./d";',
  "",
  "export function useThings(v: T, obj: { other: number }): number {",
  "  return helper(v.id) + c() + d.x + obj.other;",
  "}",
  "",
  "export function shadow(helper: number): number {",
  "  return helper + 1;",
  "}",
  "",
  "export function three(): number {",
  "  return 1;",
  "}",
  "",
  LONG_FN,
  "",
  "export class Box {",
  "  open(): void {}",
  "  close(): void {}",
  "}",
  "",
  "/** Arrow docs. */",
  "export const arrowFn = (a: number): number => {",
  "  return a;",
  "};",
  "",
  "/** @deprecated use useThings */",
  "export function old(): void {}",
  "",
  "/** @deprecated use arrowFn */",
  "export const oldArrow = (): void => {};",
  "",
  "export function secrets(): string {",
  `  const s1 = "${AKIA_SECRET}";`,
  `  const s2 = "${GHP_SECRET}";`,
  `  const s3 = "${SK_SECRET}";`,
  `  const s4 = "${B64_SECRET}";`,
  `  const ${LONG_ID} = "keep";`,
  `  return s1 + s2 + s3 + s4 + ${LONG_ID};`,
  "}",
  "",
  `export function longLine(): string { return "${FILLER}"; }`,
  "",
].join("\n");

const dir = makeTempProject({
  "src/a.ts": A_SRC,
  "src/b.ts": B_SRC,
  "src/c.ts": C_SRC,
  "src/d.ts": D_SRC,
  "src/crlf.ts": CRLF_SRC,
  "src/a.test.ts": TEST_SRC,
});
const project = buildProject(dir);
const index = buildIndex(project);
const tools = createTools(index);

/** 1-based line on which `needle` starts inside `src`. */
function lineOf(src: string, needle: string): number {
  const i = src.indexOf(needle);
  if (i < 0) throw new Error(`needle not found: ${needle}`);
  return src.slice(0, i).split("\n").length;
}

function idOf(name: string, file = "src/a.ts"): string {
  const sym = index.all().find((s) => s.name === name && s.file === file);
  if (!sym) throw new Error(`symbol not found: ${name} in ${file}`);
  return sym.symbol_id;
}

function callDef(input: unknown): ResultEnvelope {
  return tools.get_definition(input);
}

function okDef(input: unknown): GetDefinitionOutput {
  const env = callDef(input);
  if (!env.ok) throw new Error(`expected ok envelope: ${JSON.stringify(env)}`);
  const data = env.data as GetDefinitionOutput;
  GetDefinitionOutputSchema.parse(data);
  return data;
}

function def(
  name: string,
  file?: string,
  extra?: Record<string, unknown>,
): GetDefinitionOutput {
  return okDef({ symbol_id: idOf(name, file), ...extra });
}

describe("get_definition", () => {
  it("returns the exact source slice without leading JSDoc", () => {
    const three = def("three");
    expect(three.body).toBe(
      "export function three(): number {\n  return 1;\n}",
    );
    expect(three.range.start_line).toBe(lineOf(A_SRC, "export function three"));
    expect(three.range.end_line).toBe(lineOf(A_SRC, "export function three") + 2);
    expect(three.line_count).toBe(3);

    const old = def("old");
    expect(old.body).toBe("export function old(): void {}");
    expect(old.body.startsWith("/**")).toBe(false);
    expect(old.range.start_line).toBe(lineOf(A_SRC, "export function old"));
  });

  it("truncates to max_lines and expands to 120", () => {
    const truncated = def("longOne");
    expect(truncated.line_count).toBeGreaterThanOrEqual(100);
    expect(truncated.body_truncated).toBe(true);
    expect(truncated.body.split("\n")).toHaveLength(60);

    const full = def("longOne", undefined, { max_lines: 120 });
    expect(full.body_truncated).toBe(false);
    expect(full.body.split("\n")).toHaveLength(full.line_count);
    expect(full.body.split("\n").length).toBeGreaterThanOrEqual(100);
    expect(full.body.endsWith("\n")).toBe(false);
    expect(full.body.endsWith("}")).toBe(true);
  });

  it("rejects bad max_lines and unknown keys", () => {
    for (const extra of [{ max_lines: 121 }, { max_lines: 0 }, { bogus: 1 }]) {
      const env = callDef({ symbol_id: idOf("longOne"), ...extra });
      expect(env.ok, JSON.stringify(extra)).toBe(false);
      if (!env.ok) expect(env.error.code).toBe("INVALID_ARGS");
    }
  });

  it("returns a method and its whole class", () => {
    const open = def("Box.open");
    expect(open.body).toBe("  open(): void {}");
    expect(open.range.start_line).toBe(lineOf(A_SRC, "  open(): void {}"));
    expect(open.range.end_line).toBe(lineOf(A_SRC, "  open(): void {}"));
    expect(open.symbol.name).toBe("Box.open");

    const box = def("Box");
    expect(box.body).toBe(
      "export class Box {\n  open(): void {}\n  close(): void {}\n}",
    );
    expect(box.range.start_line).toBe(lineOf(A_SRC, "export class Box"));
    expect(box.range.end_line).toBe(box.range.start_line + 3);
  });

  it("returns the whole VariableStatement for an arrow const", () => {
    const arrow = def("arrowFn");
    expect(arrow.body.startsWith("export const arrowFn")).toBe(true);
    expect(arrow.body).not.toContain("Arrow docs.");
    const start = lineOf(A_SRC, "export const arrowFn");
    expect(arrow.range.start_line).toBe(start);
    expect(arrow.range.end_line).toBe(start + 2);
    expect(arrow.body.split("\n")).toHaveLength(3);
  });

  it("resolves imports through the checker, skipping property names", () => {
    const use = def("useThings");
    expect(use.imports_used).toEqual([
      { module: "./b", names: ["T", "helper"] },
      { module: "./c", names: ["c"] },
      { module: "./d", names: ["d"] },
    ]);
    expect(use.imports_used.some((i) => i.names.includes("other"))).toBe(
      false,
    );

    const shadow = def("shadow");
    expect(shadow.imports_used).toEqual([]);
  });

  it("detects @deprecated tags", () => {
    expect(def("old").deprecated).toBe(true);
    expect(def("oldArrow").deprecated).toBe(true);
    expect(def("useThings").deprecated).toBe(false);
    expect(def("three").deprecated).toBe(false);
  });

  it("redacts all four secret shapes but keeps long identifiers", () => {
    const data = def("secrets");
    for (const secret of [AKIA_SECRET, GHP_SECRET, SK_SECRET, B64_SECRET]) {
      expect(data.body).not.toContain(secret);
    }
    expect((data.body.match(/\[REDACTED\]/g) ?? []).length).toBe(4);
    expect(data.body).toContain(LONG_ID);

    const env = callDef({ symbol_id: idOf("secrets") });
    const serialized = JSON.stringify(env);
    for (const secret of [AKIA_SECRET, GHP_SECRET, SK_SECRET, B64_SECRET]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).toContain(LONG_ID);
  });

  it("caps a single 20000-character line at 6144 bytes", () => {
    const env = callDef({ symbol_id: idOf("longLine") });
    expect(env.ok).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(env), "utf8")).toBeLessThanOrEqual(
      6144,
    );
    const data = env.ok ? (env.data as GetDefinitionOutput) : undefined;
    expect(data?.body_truncated).toBe(true);
    expect(data?.line_count).toBe(1);
  });

  it("normalizes CRLF line endings and keeps line numbers", () => {
    const crlf = def("crlfOne", "src/crlf.ts");
    expect(crlf.body).toBe(
      "export function crlfOne(a: number): number {\n  return a;\n}",
    );
    expect(crlf.body).not.toContain("\r");
    expect(crlf.range.start_line).toBe(1);
    expect(crlf.range.end_line).toBe(3);
    expect(crlf.line_count).toBe(3);
  });

  it("maps bad ids to error envelopes without throwing", () => {
    const unknown = callDef({ symbol_id: "s_9999" });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.code).toBe("UNKNOWN_SYMBOL");

    for (const bad of ["x", null, "s_1"]) {
      const env = callDef(bad);
      expect(env.ok, String(bad)).toBe(false);
      if (!env.ok) expect(env.error.code).toBe("INVALID_ARGS");
    }
  });

  it("fetches test-file symbols and reports no diff", () => {
    const testSym = def("testOnly", "src/a.test.ts");
    expect(testSym.symbol.is_test).toBe(true);
    expect(testSym.in_current_diff).toBe(false);
  });

  it("never leaks the project root and is deterministic", () => {
    const first = callDef({ symbol_id: idOf("useThings") });
    const second = callDef({ symbol_id: idOf("useThings") });
    expect(second).toEqual(first);

    const env = callDef({ symbol_id: idOf("secrets") });
    const serialized = JSON.stringify(env);
    for (const variant of [dir, toForwardSlashes(dir)]) {
      expect(serialized.toLowerCase()).not.toContain(variant.toLowerCase());
    }
    expect(env.ok).toBe(true);
    if (env.ok) {
      expect(GetDefinitionOutputSchema.parse(env.data).in_current_diff).toBe(
        false,
      );
    }
  });
});
