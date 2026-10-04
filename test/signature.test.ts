import { describe, expect, it } from "vitest";
import { buildIndex, buildProject, toForwardSlashes } from "../src/index.js";
import type { GetSignatureOutput, ResultEnvelope } from "../src/schemas.js";
import { GetSignatureOutputSchema } from "../src/schemas.js";
import type { SignatureCompat } from "../src/schemas.js";
import { createTools } from "../src/tools.js";
import { makeTempProject } from "./helpers.js";

// Built dynamically so this test source contains no token-shaped literal.
const AKIA_SECRET = "AKIA" + "0123456789ABCDEF";

// ~190 chars per type: 60 of them blow the 6 KB envelope cap.
const LONG_TYPE =
  "{ " +
  [
    "alphaValue",
    "betaValue",
    "gammaValue",
    "deltaValue",
    "epsilonValue",
    "zetaValue",
    "etaValue",
    "thetaValue",
    "iotaValue",
    "kappaValue",
  ]
    .map((k) => `${k}: string`)
    .join("; ") +
  " }";

// ~66 chars per type: 12 of them clear the 300-char cut but stay well under 6 KB.
const MID_TYPE = "{ aaa: string; bbb: number; ccc: boolean; ddd: string; eee: number }";

function paramList(prefix: string, count: number, type: string): string {
  return Array.from(
    { length: count },
    (_, i) => `${prefix}${i}: ${type}`,
  ).join(", ");
}

const A_SRC = [
  'import * as b from "./b";',
  "",
  "export function plain(a: number, b?: string, c: boolean = true): void {}",
  "export function rest(first: string, ...others: number[]): string { return first; }",
  "export function destruct({ a, b }: { a: number; b: string }): number { return a; }",
  "export function identity<T extends object = {}>(value: T): T { return value; }",
  "export async function fetchText(url: string): Promise<string> { return url; }",
  "export const arrow = (x: number): number => x;",
  "export const asyncArrow = async (x: number) => x;",
  "export class Greeter {",
  "  greet(name: string): string { return name; }",
  "  static make(): Greeter { return new Greeter(); }",
  "}",
  "",
  "export interface Named { name: string }",
  "export type Alias = string;",
  "export const count = 41;",
  "",
  "export function overloaded(a: string): string;",
  "export function overloaded(a: number): number;",
  "export function overloaded(a: string): string { return a; }",
  "",
  `export function withLiteral(k: "${AKIA_SECRET}"): void {}`,
  "export function useNs(m: typeof b): void {}",
  "",
  "export function same1(x: string): string { return x; }",
  "export function same2(y: string): string { return y; }",
  "export function extraReq(x: string, y: number): string { return x; }",
  "export function narrowIn(x: string): string { return x; }",
  "export function wideIn(x: string | number): string { return x as string; }",
  "export function retStr(): string { return ''; }",
  "export function retNum(): number { return 0; }",
  "export function retWide(): string | number { return ''; }",
  "export function syncPromise(url: string): Promise<string> { return Promise.resolve(url); }",
  "",
  `export function many(${paramList("m", 12, MID_TYPE)}): void {}`,
  `export function big60(${paramList("p", 60, LONG_TYPE)}): void {}`,
  "",
].join("\n");

const B_SRC = "export const bs = 1;\n";

const dir = makeTempProject({
  "tsconfig.json": JSON.stringify({
    compilerOptions: {
      strict: true,
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
    },
  }),
  "src/a.ts": A_SRC,
  "src/b.ts": B_SRC,
});
const project = buildProject(dir);
const index = buildIndex(project);
const tools = createTools(index);

function idOf(name: string, file = "src/a.ts"): string {
  const sym = index.all().find((s) => s.name === name && s.file === file);
  if (!sym) throw new Error(`symbol not found: ${name} in ${file}`);
  return sym.symbol_id;
}

function callSig(input: unknown): ResultEnvelope {
  return tools.get_signature(input);
}

function sig(name: string, extra?: Record<string, unknown>): GetSignatureOutput {
  const env = callSig({ symbol_id: idOf(name), ...extra });
  if (!env.ok) throw new Error(`expected ok envelope: ${JSON.stringify(env)}`);
  const data = env.data as GetSignatureOutput;
  GetSignatureOutputSchema.parse(data);
  return data;
}

function compatOf(a: string, b: string): SignatureCompat {
  const data = sig(a, { compare_to: idOf(b) });
  if (!data.compat) throw new Error(`expected compat for ${a} vs ${b}`);
  return data.compat;
}

describe("get_signature", () => {
  it("reports plain parameters, optionality and defaults", () => {
    const plain = sig("plain");
    expect(plain.name).toBe("plain");
    expect(plain.type_signature).toBe(
      "plain(a: number, b?: string | undefined, c?: boolean): void",
    );
    expect(plain.params).toEqual([
      { name: "a", type: "number", optional: false },
      // Surprising but correct: strict mode widens `b?: string` to
      // "string | undefined" when the checker prints the parameter type.
      { name: "b", type: "string | undefined", optional: true },
      // A default keeps the declared type, so this is "boolean" rather than
      // "boolean | undefined"; the initializer is what marks it optional.
      { name: "c", type: "boolean", optional: true },
    ]);
    expect(plain.return_type).toBe("void");
    expect(plain.type_params).toEqual([]);
    expect(plain.is_async).toBe(false);
    expect(plain.exported).toBe(true);
    expect(plain.compat).toBeUndefined();
  });

  it("handles rest and destructured parameters", () => {
    const rest = sig("rest");
    expect(rest.type_signature).toBe(
      "rest(first: string, ...others: number[]): string",
    );
    expect(rest.params).toEqual([
      { name: "first", type: "string", optional: false },
      // A rest parameter is always reported as optional.
      { name: "others", type: "number[]", optional: true },
    ]);
    expect(rest.return_type).toBe("string");
    expect(rest.type_params).toEqual([]);
    expect(rest.is_async).toBe(false);
    expect(rest.exported).toBe(true);

    const destruct = sig("destruct");
    expect(destruct.type_signature).toBe(
      "destruct({ a, b }: { a: number; b: string; }): number",
    );
    expect(destruct.params).toEqual([
      { name: "{ a, b }", type: "{ a: number; b: string; }", optional: false },
    ]);
    expect(destruct.return_type).toBe("number");
    expect(destruct.type_params).toEqual([]);
    expect(destruct.exported).toBe(true);
  });

  it("reports type params, async functions and methods", () => {
    const identity = sig("identity");
    expect(identity.type_signature).toBe(
      "identity<T extends object = {}>(value: T): T",
    );
    expect(identity.type_params).toEqual(["T extends object = {}"]);
    expect(identity.params).toEqual([
      { name: "value", type: "T", optional: false },
    ]);
    expect(identity.return_type).toBe("T");
    expect(identity.is_async).toBe(false);
    expect(identity.exported).toBe(true);

    const fetchText = sig("fetchText");
    expect(fetchText.type_signature).toBe(
      "fetchText(url: string): Promise<string>",
    );
    expect(fetchText.params).toEqual([
      { name: "url", type: "string", optional: false },
    ]);
    expect(fetchText.return_type).toBe("Promise<string>");
    expect(fetchText.is_async).toBe(true);
    expect(fetchText.exported).toBe(true);

    const arrow = sig("arrow");
    expect(arrow.type_signature).toBe("arrow(x: number): number");
    expect(arrow.params).toEqual([{ name: "x", type: "number", optional: false }]);
    expect(arrow.return_type).toBe("number");
    expect(arrow.is_async).toBe(false);
    expect(arrow.exported).toBe(true);

    const asyncArrow = sig("asyncArrow");
    expect(asyncArrow.type_signature).toBe(
      "asyncArrow(x: number): Promise<number>",
    );
    // Inferred from the async modifier, not written in the source.
    expect(asyncArrow.return_type).toBe("Promise<number>");
    expect(asyncArrow.is_async).toBe(true);
    expect(asyncArrow.exported).toBe(true);

    const greet = sig("Greeter.greet");
    expect(greet.name).toBe("Greeter.greet");
    expect(greet.type_signature).toBe("Greeter.greet(name: string): string");
    expect(greet.params).toEqual([
      { name: "name", type: "string", optional: false },
    ]);
    expect(greet.return_type).toBe("string");
    expect(greet.is_async).toBe(false);
    expect(greet.exported).toBe(true);

    const make = sig("Greeter.make");
    expect(make.name).toBe("Greeter.make");
    expect(make.type_signature).toBe("Greeter.make(): Greeter");
    expect(make.params).toEqual([]);
    expect(make.return_type).toBe("Greeter");
    expect(make.is_async).toBe(false);
    expect(make.exported).toBe(true);
  });

  it("type_signature skips the 300-char cut", () => {
    const many = sig("many");
    expect(many.type_signature.length).toBeGreaterThan(300);
    const summary = index.getById(idOf("many"));
    expect(summary).toBeDefined();
    // SymbolSummary.signature keeps the 297 + "..." cap; type_signature does not.
    expect(summary?.signature).toBe(many.type_signature.slice(0, 297) + "...");
  });

  it("uses the first overload declaration", () => {
    const overloaded = sig("overloaded");
    expect(overloaded.type_signature).toBe("overloaded(a: string): string");
    expect(overloaded.params).toEqual([
      { name: "a", type: "string", optional: false },
    ]);
    expect(overloaded.return_type).toBe("string");
    expect(overloaded.type_params).toEqual([]);
    expect(overloaded.is_async).toBe(false);
    expect(overloaded.exported).toBe(true);
  });

  it("rejects symbols without a call signature", () => {
    for (const name of ["Named", "Alias", "count", "Greeter"]) {
      const env = callSig({ symbol_id: idOf(name) });
      expect(env.ok, name).toBe(false);
      if (!env.ok) {
        expect(env.error.code).toBe("INVALID_ARGS");
        expect(env.error.message).toBe("symbol has no call signature");
      }
    }
  });

  it("maps unknown and malformed ids to error envelopes", () => {
    const unknown = callSig({ symbol_id: "s_9999" });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.code).toBe("UNKNOWN_SYMBOL");

    const malformed = callSig({ symbol_id: "x" });
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.error.code).toBe("INVALID_ARGS");
  });

  it("rejects malformed input without throwing", () => {
    for (const bad of [null, "str", 42, undefined, true, [], "s_1"]) {
      const env = callSig(bad);
      expect(env.ok, String(bad)).toBe(false);
      if (!env.ok) expect(env.error.code).toBe("INVALID_ARGS");
    }
    const unknownKey = callSig({ symbol_id: idOf("plain"), bogus: 1 });
    expect(unknownKey.ok).toBe(false);
    if (!unknownKey.ok) expect(unknownKey.error.code).toBe("INVALID_ARGS");
  });

  it("redacts secrets in parameter types", () => {
    const wl = sig("withLiteral");
    expect(wl.params).toEqual([
      // Quotes come from the literal type; the token inside is redacted.
      { name: "k", type: '"[REDACTED]"', optional: false },
    ]);
    expect(wl.return_type).toBe("void");

    const env = callSig({ symbol_id: idOf("withLiteral") });
    const serialized = JSON.stringify(env);
    expect(serialized).not.toContain(AKIA_SECRET);
    expect(serialized).toContain("[REDACTED]");
  });

  it("scrubs the project root out of namespace types", () => {
    const ns = sig("useNs");
    expect(ns.params).toHaveLength(1);
    const type = ns.params[0].type;
    expect(type).toContain('import("./src/b")');
    for (const variant of [dir, toForwardSlashes(dir)]) {
      expect(type).not.toContain(variant);
      expect(type.toLowerCase()).not.toContain(variant.toLowerCase());
    }
  });

  it("computes compat in the A -> B direction", () => {
    expect(compatOf("same1", "same2")).toEqual({
      same_param_count: true,
      params_assignable: true,
      return_assignable: true,
      async_match: true,
    });
    expect(compatOf("same1", "same1")).toEqual({
      same_param_count: true,
      params_assignable: true,
      return_assignable: true,
      async_match: true,
    });
    expect(compatOf("same1", "extraReq")).toEqual({
      same_param_count: false,
      params_assignable: false,
      return_assignable: true,
      async_match: true,
    });
    expect(compatOf("extraReq", "same1")).toEqual({
      same_param_count: false,
      params_assignable: false,
      return_assignable: true,
      async_match: true,
    });
    expect(compatOf("narrowIn", "wideIn")).toEqual({
      same_param_count: true,
      params_assignable: true,
      return_assignable: true,
      async_match: true,
    });
    expect(compatOf("wideIn", "narrowIn")).toEqual({
      same_param_count: true,
      params_assignable: false,
      return_assignable: true,
      async_match: true,
    });
    expect(compatOf("retStr", "retNum")).toEqual({
      same_param_count: true,
      params_assignable: true,
      return_assignable: false,
      async_match: true,
    });
    expect(compatOf("retWide", "retStr")).toEqual({
      same_param_count: true,
      params_assignable: true,
      return_assignable: true,
      async_match: true,
    });
    expect(compatOf("retStr", "retWide")).toEqual({
      same_param_count: true,
      params_assignable: true,
      return_assignable: false,
      async_match: true,
    });
    expect(compatOf("fetchText", "syncPromise")).toEqual({
      same_param_count: true,
      params_assignable: true,
      return_assignable: true,
      async_match: false,
    });
    // Generic signatures and rest parameters cannot be compared exactly.
    expect(compatOf("identity", "same1")).toEqual({
      same_param_count: true,
      params_assignable: "unknown",
      return_assignable: "unknown",
      async_match: true,
    });
    expect(compatOf("rest", "same1")).toEqual({
      same_param_count: false,
      params_assignable: "unknown",
      return_assignable: "unknown",
      async_match: true,
    });
  });

  it("rejects a non-callable or unknown compare_to", () => {
    const classTarget = callSig({
      symbol_id: idOf("plain"),
      compare_to: idOf("Greeter"),
    });
    expect(classTarget.ok).toBe(false);
    if (!classTarget.ok) expect(classTarget.error.code).toBe("INVALID_ARGS");

    const unknown = callSig({
      symbol_id: idOf("plain"),
      compare_to: "s_9999",
    });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.code).toBe("UNKNOWN_SYMBOL");
  });

  it("returns BUDGET_EXCEEDED instead of dropping parameters", () => {
    const env = callSig({ symbol_id: idOf("big60") });
    expect(env.ok).toBe(false);
    if (!env.ok) {
      expect(env.error.code).toBe("BUDGET_EXCEEDED");
      expect(env.error.message).toBe("signature too large");
    }
  });

  it("validates output, never leaks the root and is deterministic", () => {
    for (const name of [
      "plain",
      "rest",
      "destruct",
      "identity",
      "fetchText",
      "arrow",
      "asyncArrow",
      "Greeter.greet",
      "Greeter.make",
      "overloaded",
      "many",
      "useNs",
      "withLiteral",
    ]) {
      const env = callSig({ symbol_id: idOf(name) });
      expect(env.ok, name).toBe(true);
      if (env.ok) GetSignatureOutputSchema.parse(env.data);
    }

    const env = callSig({ symbol_id: idOf("useNs") });
    const serialized = JSON.stringify(env);
    for (const variant of [dir, toForwardSlashes(dir)]) {
      expect(serialized.toLowerCase()).not.toContain(variant.toLowerCase());
    }

    const first = callSig({ symbol_id: idOf("plain") });
    const second = callSig({ symbol_id: idOf("plain") });
    expect(second).toEqual(first);
  });
});
