import { describe, expect, it } from "vitest";
import { buildProject, extractSymbols, isTestPath } from "../src/index.js";
import { makeTempProject } from "./helpers.js";

const A_TS = `/** Formats a number as currency. More detail. */
export function formatCurrency(n: number): string {
  function inner(): number {
    return 1;
  }
  return String(n);
}
export const arrow = (x: number): number => x;
const count = 41;
export class Greeter {
  greet(name: string): string {
    return name;
  }
  static make(): Greeter {
    return new Greeter();
  }
  private hidden(): void {}
  constructor() {}
  get value(): number {
    return 1;
  }
}
export interface Named {
  name: string;
}
export type Alias = string | number;
function hidden(): number {
  return 7;
}
export { hidden };
export function overloaded(a: string): string;
export function overloaded(a: number): number;
export function overloaded(a: unknown): unknown {
  return a;
}
enum Color {
  Red = 1,
}
export const { x, y } = { x: 1, y: 2 };
`;

const B_TS = `export { formatCurrency } from "./a";
export default function () {}
`;

const A_TEST_TS = `export function testHelper(): number {
  return 1;
}
`;

function buildFixture(): string {
  return makeTempProject({
    "src/a.ts": A_TS,
    "src/b.ts": B_TS,
    "src/a.test.ts": A_TEST_TS,
  });
}

describe("isTestPath", () => {
  it("flags test paths", () => {
    for (const p of [
      "a.test.ts",
      "a.spec.tsx",
      "__tests__/a.ts",
      "test/a.ts",
      "src/tests/a.ts",
    ]) {
      expect(isTestPath(p), p).toBe(true);
    }
  });

  it("rejects lookalikes", () => {
    for (const p of [
      "src/latest.ts",
      "src/contest/a.ts",
      "src/testing/a.ts",
      "test.ts",
    ]) {
      expect(isTestPath(p), p).toBe(false);
    }
  });
});

describe("extractSymbols", () => {
  it("extracts the fixture symbols", () => {
    const project = buildProject(buildFixture());
    const symbols = extractSymbols(project);
    const byName = new Map(symbols.map((s) => [s.name, s]));

    expect(byName.get("formatCurrency")?.kind).toBe("function");
    expect(byName.get("formatCurrency")?.exported).toBe(true);
    expect(byName.get("formatCurrency")?.file).toBe("src/a.ts");
    expect(byName.get("formatCurrency")?.line).toBe(2);
    expect(byName.get("formatCurrency")?.doc_summary).toBe(
      "Formats a number as currency.",
    );
    expect(byName.get("arrow")?.kind).toBe("function");
    expect(byName.get("arrow")?.exported).toBe(true);
    expect(byName.get("count")?.kind).toBe("const");
    expect(byName.get("count")?.exported).toBe(false);
    expect(byName.get("Greeter")?.kind).toBe("class");
    expect(byName.get("Greeter")?.exported).toBe(true);
    expect(byName.get("Greeter.greet")?.kind).toBe("method");
    expect(byName.get("Greeter.greet")?.exported).toBe(true);
    expect(byName.get("Greeter.make")?.kind).toBe("method");
    expect(byName.get("Greeter.make")?.exported).toBe(true);
    expect(byName.get("Named")?.kind).toBe("interface");
    expect(byName.get("Named")?.exported).toBe(true);
    expect(byName.get("Alias")?.kind).toBe("type");
    expect(byName.get("Alias")?.exported).toBe(true);
    expect(byName.get("hidden")?.kind).toBe("function");
    expect(byName.get("hidden")?.exported).toBe(true);

    const overloaded = symbols.filter((s) => s.name === "overloaded");
    expect(overloaded.length).toBe(1);

    for (const absent of [
      "Greeter.hidden",
      "Greeter.constructor",
      "Greeter.value",
      "inner",
      "Color",
      "x",
      "y",
    ]) {
      expect(byName.has(absent), absent).toBe(false);
    }
    expect(symbols.some((s) => s.file === "src/b.ts")).toBe(false);

    const helper = byName.get("testHelper");
    expect(helper?.is_test).toBe(true);
    expect(byName.get("formatCurrency")?.is_test).toBe(false);

    const lines: Record<string, number> = {
      arrow: 8,
      count: 9,
      Greeter: 10,
      "Greeter.greet": 11,
      "Greeter.make": 14,
      Named: 23,
      Alias: 26,
      hidden: 27,
      overloaded: 31,
      testHelper: 1,
    };
    for (const [name, line] of Object.entries(lines)) {
      expect(byName.get(name)?.line, name).toBe(line);
    }
  });

  it("is deterministic", () => {
    const dir = buildFixture();
    const project = buildProject(dir);
    const first = extractSymbols(project).map((s) => [
      s.file,
      s.line,
      s.kind,
      s.name,
      s.exported,
      s.is_test,
      s.doc_summary,
    ]);
    const second = extractSymbols(project).map((s) => [
      s.file,
      s.line,
      s.kind,
      s.name,
      s.exported,
      s.is_test,
      s.doc_summary,
    ]);
    expect(second).toEqual(first);
  });
});
