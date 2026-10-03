import { describe, expect, it } from "vitest";
import { buildIndex, buildProject, toForwardSlashes, toSummary } from "../src/index.js";
import { SymbolSummarySchema } from "../src/schemas.js";
import { makeTempProject } from "./helpers.js";

function params(n: number): string {
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    parts.push(`p${i}: number`);
  }
  return parts.join(", ");
}

const A_TS = `export function add(a: number, b?: number): number {
  return a + (b ?? 0);
}
export function withDefault(a: number, b: number = 2): number {
  return a + b;
}
export function identity<T>(value: T): T {
  return value;
}
export async function fetchText(url: string): Promise<string> {
  return url;
}
/** Adds numbers. Extra. */
export const plus = (a: number, b: number): number => a + b;
export class Greeter {
  greet(name: string): string {
    return name;
  }
}
export interface Named {
  name: string;
}
export type Alias = string | number;
export const count = 41;
export function overloaded(a: string): string;
export function overloaded(a: number): number;
export function overloaded(a: unknown): unknown {
  return a as number;
}
export function big(${params(40)}): number {
  return 0;
}
`;

const T_TS = `export function testHelper(): number {
  return 1;
}
`;

function buildFixture(): string {
  return makeTempProject({
    "src/a.ts": A_TS,
    "src/t.test.ts": T_TS,
  });
}

describe("index ids and signatures", () => {
  it("assigns sequential ids and deterministic signatures", () => {
    const dir = buildFixture();
    const first = buildIndex(buildProject(dir));
    const second = buildIndex(buildProject(dir));
    const ids = first.all().map((s) => s.symbol_id);
    expect(ids).toEqual(ids.map((_, i) => `s_${i + 1}`));
    expect(second.all().map((s) => s.signature)).toEqual(
      first.all().map((s) => s.signature),
    );
    expect(second.all().map((s) => s.symbol_id)).toEqual(ids);
  });

  it("rejects invalid ids", () => {
    const index = buildIndex(buildProject(buildFixture()));
    for (const bad of ["s_0", "s_999", "x", ""]) {
      expect(index.getById(bad), bad).toBeUndefined();
    }
    expect(index.getById("s_1")?.symbol_id).toBe("s_1");
  });

  it("computes exact signature strings", () => {
    const index = buildIndex(buildProject(buildFixture()));
    const byName = new Map(index.all().map((s) => [s.name, s]));
    expect(byName.get("add")?.signature).toBe(
      "add(a: number, b?: number): number",
    );
    expect(byName.get("withDefault")?.signature).toBe(
      "withDefault(a: number, b?: number): number",
    );
    expect(byName.get("identity")?.signature).toBe(
      "identity<T>(value: T): T",
    );
    expect(byName.get("fetchText")?.signature).toBe(
      "fetchText(url: string): Promise<string>",
    );
    expect(byName.get("plus")?.signature).toBe(
      "plus(a: number, b: number): number",
    );
    expect(byName.get("Greeter.greet")?.signature).toBe(
      "Greeter.greet(name: string): string",
    );
    expect(byName.get("Greeter")?.signature).toBe("class Greeter");
    expect(byName.get("Named")?.signature).toBe("interface Named");
    expect(byName.get("Alias")?.signature).toBe("type Alias = string | number");
    expect(byName.get("count")?.signature).toBe("const count: 41");
    const overloaded = index.all().filter((s) => s.name === "overloaded");
    expect(overloaded.length).toBe(1);
    expect(overloaded[0]?.signature).toBe("overloaded(a: string): string");
  });

  it("truncates the 40-parameter signature", () => {
    const index = buildIndex(buildProject(buildFixture()));
    const big = index.all().find((s) => s.name === "big");
    expect(big).toBeDefined();
    expect(big?.signature.length).toBeLessThanOrEqual(300);
    expect(big?.signature.endsWith("...")).toBe(true);
  });

  it("reads the arrow const doc summary", () => {
    const index = buildIndex(buildProject(buildFixture()));
    const plus = index.all().find((s) => s.name === "plus");
    expect(plus?.doc_summary).toBe("Adds numbers.");
  });

  it("summaries validate against the schema", () => {
    const index = buildIndex(buildProject(buildFixture()));
    for (const sym of index.all()) {
      expect(() => SymbolSummarySchema.parse(toSummary(sym))).not.toThrow();
    }
  });

  it("findEnclosing resolves innermost symbols", () => {
    const dir = buildFixture();
    const project = buildProject(dir);
    const index = buildIndex(project);
    const byName = new Map(index.all().map((s) => [s.name, s]));
    const add = byName.get("add");
    const greet = byName.get("Greeter.greet");
    const greeter = byName.get("Greeter");
    expect(add && greet && greeter).toBeTruthy();
    const mid = (s: { startOffset: number; endOffset: number }): number =>
      Math.floor((s.startOffset + s.endOffset) / 2);
    expect(
      index.findEnclosing("src/a.ts", mid(add!))?.symbol_id,
    ).toBe(add!.symbol_id);
    expect(
      index.findEnclosing("src/a.ts", mid(greet!))?.symbol_id,
    ).toBe(greet!.symbol_id);
    const gap = greet!.endOffset + 1;
    expect(gap).toBeLessThan(greeter!.endOffset);
    expect(index.findEnclosing("src/a.ts", gap)?.symbol_id).toBe(
      greeter!.symbol_id,
    );
    expect(index.findEnclosing("src/a.ts", Number.MAX_SAFE_INTEGER)).toBeUndefined();
  });

  it("scrubs project paths out of signatures", () => {
    const dir = makeTempProject({
      "src/b.ts": "export const b: number = 1;\n",
      "src/a.ts": 'import * as b from "./b";\nexport const ns = b;\n',
    });
    const index = buildIndex(buildProject(dir));
    const ns = index.all().find((s) => s.name === "ns");
    expect(ns).toBeDefined();
    expect(ns?.signature).toContain('import("./src/b")');
    expect(ns?.signature).not.toContain(toForwardSlashes(dir));
    expect(ns?.signature).not.toContain(dir);
  });
});
