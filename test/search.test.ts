import { describe, expect, it } from "vitest";
import { buildIndex, buildProject, toForwardSlashes } from "../src/index.js";
import type { ResultEnvelope, SearchSymbolsOutput } from "../src/schemas.js";
import { createTools } from "../src/tools.js";
import { makeTempProject } from "./helpers.js";

const CSV_TS = `/** Exports rows to CSV format. */
export function exportCsv(rows: string[][]): string {
  return rows.length.toString();
}
export class CsvWriter {
  write(row: string[]): void {
    row.length;
  }
}
`;

const SHIPPING_TS = `/** Calculates shipping cost. */
export function calculateShipping(weight: number): number {
  return weight;
}
export function getShippingCost(weight: number): number {
  return weight;
}
`;

const DATES_TS = `/** Formats a date as ISO text. */
export function toIso(d: Date): string {
  return d.toISOString();
}
export function isEven(n: number): boolean {
  return n % 2 === 0;
}
`;

const IDS_TS = `export function parse_user_id(s: string): number {
  return Number(s);
}
`;

const CSV_TEST_TS = `export function exportCsvCheck(): void {
  return;
}
`;

function buildFixture(): {
  dir: string;
  tools: ReturnType<typeof createTools>;
} {
  const dir = makeTempProject({
    "src/csv.ts": CSV_TS,
    "src/shipping.ts": SHIPPING_TS,
    "src/dates.ts": DATES_TS,
    "src/ids.ts": IDS_TS,
    "src/exportCsv.test.ts": CSV_TEST_TS,
  });
  const tools = createTools(buildIndex(buildProject(dir)));
  return { dir, tools };
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

// __TESTS__

describe("search_symbols", () => {
  it("splits camelCase tokens and hides tests by default", () => {
    const { tools } = buildFixture();
    const env = tools.search_symbols({ query: "export csv" });
    expect(env.ok).toBe(true);
    expect(names(env)[0]).toBe("exportCsv");
    expect(names(env)).not.toContain("exportCsvCheck");
    const withTests = tools.search_symbols({
      query: "export csv",
      include_tests: true,
    });
    expect(names(withTests)).toContain("exportCsvCheck");
  });

  it("gives the full-name bonus", () => {
    const { tools } = buildFixture();
    const data = okData(tools.search_symbols({ query: "exportCsv" }));
    expect(data.results[0]?.name).toBe("exportCsv");
    expect(data.results[0]?.match).toBe("name");
  });

  it("finds methods through their qualified name tokens", () => {
    const { tools } = buildFixture();
    const data = okData(tools.search_symbols({ query: "write" }));
    const hit = data.results.find((r) => r.name === "CsvWriter.write");
    expect(hit).toBeDefined();
    expect(hit?.match).toBe("name");
  });

  it("reports the highest contributing source as match", () => {
    const { tools } = buildFixture();
    // Task 10: "formats" now also stems to "format", which exportCsv's doc
    // ("Exports rows to CSV format.") holds literally. That stem-only doc hit
    // is a real recall gain, so it appears BELOW the exact-doc hit toIso
    // (which contains the literal "Formats"); the ranking is unchanged.
    const byDoc = okData(tools.search_symbols({ query: "formats" })).results;
    expect(byDoc.map((r) => r.name)).toEqual(["toIso", "exportCsv"]);
    expect(byDoc[0]?.match).toBe("doc");
    expect(byDoc[0]?.name).toBe("toIso");
    const bySig = okData(tools.search_symbols({ query: "boolean" })).results;
    expect(bySig.map((r) => r.name)).toEqual(["isEven"]);
    expect(bySig[0]?.match).toBe("signature");
  });

  it('ranks the "cost" matches by hand-computed score', () => {
    const { tools } = buildFixture();
    const data = okData(tools.search_symbols({ query: "cost" }));
    // getShippingCost: name token "cost" (3) + signature token "cost" (1) = 4, match name.
    // calculateShipping: doc token "cost" only (1.5), match doc.
    expect(data.results.map((r) => r.name)).toEqual([
      "getShippingCost",
      "calculateShipping",
    ]);
    expect(data.results[0]?.match).toBe("name");
    expect(data.results[1]?.match).toBe("doc");
  });

  it("splits snake_case names", () => {
    const { tools } = buildFixture();
    const data = okData(tools.search_symbols({ query: "user id" }));
    expect(data.results.map((r) => r.name)).toEqual(["parse_user_id"]);
    expect(data.results[0]?.match).toBe("name");
  });

  it("orders equal scores by file path then line", () => {
    const { tools } = buildFixture();
    // "number" only appears in signature tokens (1 each) for these four.
    const data = okData(tools.search_symbols({ query: "number" }));
    expect(data.results.map((r) => r.name)).toEqual([
      "isEven",
      "parse_user_id",
      "calculateShipping",
      "getShippingCost",
    ]);
  });

  it("applies kind and path_prefix filters", () => {
    const { tools } = buildFixture();
    const funcs = okData(
      tools.search_symbols({ query: "export csv", kind: "function" }),
    );
    expect(funcs.results.map((r) => r.name)).toEqual(["exportCsv"]);
    const prefixed = okData(
      tools.search_symbols({ query: "export csv", path_prefix: "src/csv" }),
    );
    expect(prefixed.results.every((r) => r.file === "src/csv.ts")).toBe(true);
    expect(prefixed.results.map((r) => r.name)).toContain("CsvWriter");
    const backslashed = okData(
      tools.search_symbols({
        query: "export csv",
        path_prefix: ".\\src\\csv",
      }),
    );
    expect(backslashed.results.map((r) => r.name)).toContain("exportCsv");
  });

  it("rejects non-relative path prefixes", () => {
    const { tools } = buildFixture();
    for (const bad of ["../x", "C:/x", "/abs", "src/../x", "c:\\x"]) {
      const env = tools.search_symbols({ query: "export", path_prefix: bad });
      expect(env.ok, bad).toBe(false);
      if (!env.ok) expect(env.error.code).toBe("INVALID_ARGS");
    }
  });

// __TESTS2__

  it("handles limits, empty queries and zero matches", () => {
    const { tools } = buildFixture();
    const limited = okData(
      tools.search_symbols({ query: "export csv", limit: 1 }),
    );
    expect(limited.results).toHaveLength(1);
    expect(limited.truncated).toBe(true);
    for (const bad of [11, 0, -1]) {
      const env = tools.search_symbols({ query: "export csv", limit: bad });
      expect(env.ok, `limit ${bad}`).toBe(false);
      if (!env.ok) expect(env.error.code).toBe("INVALID_ARGS");
    }
    const blank = tools.search_symbols({ query: "   " });
    expect(blank.ok).toBe(false);
    if (!blank.ok) expect(blank.error.code).toBe("INVALID_ARGS");
    const none = okData(tools.search_symbols({ query: "xyzzy" }));
    expect(none.results).toEqual([]);
    expect(none.truncated).toBe(false);
  });

  it("rejects malformed input without throwing", () => {
    const { tools } = buildFixture();
    for (const bad of [null, "str", 42, undefined, true, []]) {
      const env = tools.search_symbols(bad);
      expect(env.ok).toBe(false);
      if (!env.ok) expect(env.error.code).toBe("INVALID_ARGS");
    }
    const unknownKey = tools.search_symbols({ query: "export", bogus: 1 });
    expect(unknownKey.ok).toBe(false);
    if (!unknownKey.ok) expect(unknownKey.error.code).toBe("INVALID_ARGS");
  });

  it("never leaks the project root or symbol bodies", () => {
    const { dir, tools } = buildFixture();
    const env = tools.search_symbols({
      query: "export csv",
      include_tests: true,
    });
    const serialized = JSON.stringify(env);
    expect(serialized).not.toContain('"body"');
    const variants = [
      dir,
      toForwardSlashes(dir),
      JSON.stringify(dir).slice(1, -1),
    ];
    for (const variant of variants) {
      expect(serialized.toLowerCase()).not.toContain(variant.toLowerCase());
    }
  });

  it("trims results to the serialized size cap", () => {
    const doc = `/** capmatch ${"filler ".repeat(90)} */`;
    const params = Array.from(
      { length: 40 },
      (_, i) => `p${i}: number`,
    ).join(", ");
    let src = "";
    for (let i = 0; i < 12; i++) {
      src += `${doc}\nexport function capFn${i}(${params}): number {\n  return 0;\n}\n`;
    }
    const dir = makeTempProject({ "src/cap.ts": src });
    const tools = createTools(buildIndex(buildProject(dir)));
    const env = tools.search_symbols({ query: "capmatch", limit: 10 });
    const data = okData(env);
    expect(Buffer.byteLength(JSON.stringify(env), "utf8")).toBeLessThanOrEqual(
      6144,
    );
    expect(data.truncated).toBe(true);
    expect(data.results.length).toBeGreaterThan(0);
    expect(data.results.length).toBeLessThan(10);
  });

  it("is deterministic", () => {
    const { tools } = buildFixture();
    const first = tools.search_symbols({ query: "shipping cost" });
    const second = tools.search_symbols({ query: "shipping cost" });
    expect(second).toEqual(first);
  });

  it("reaches a trailing-digit name from its split part", () => {
    const dir = makeTempProject({
      "src/round.ts": `export function round2(n: number): number {\n  return Math.round(n * 100) / 100;\n}\n`,
      "src/money.ts": `/** Rounds up to two decimal places. */\nexport function roundUpCents(n: number): number {\n  return Math.ceil(n * 100) / 100;\n}\n`,
    });
    const tools = createTools(buildIndex(buildProject(dir)));
    // "round" used to return only roundUpCents; round2 is now reachable.
    const byPart = okData(tools.search_symbols({ query: "round" })).results;
    expect(byPart.map((r) => r.name)).toContain("round2");
    // The exact name still matches and still ranks first.
    const byExact = okData(tools.search_symbols({ query: "round2" })).results;
    expect(byExact[0]?.name).toBe("round2");
    expect(byExact[0]?.match).toBe("name");
  });

  it("reaches a plural/suffixed word through light stemming", () => {
    const dir = makeTempProject({
      "src/throttle.ts":
        `/** True when the alert was suppressed for this window. */\n` +
        `export function shouldNotify(): boolean {\n  return true;\n}\n`,
      "src/alerts.ts": `export const alerts: string[] = [];\n`,
    });
    const tools = createTools(buildIndex(buildProject(dir)));
    expect(
      okData(tools.search_symbols({ query: "suppress" })).results.map(
        (r) => r.name,
      ),
    ).toContain("shouldNotify");
    expect(
      okData(tools.search_symbols({ query: "alert" })).results.map(
        (r) => r.name,
      ),
    ).toContain("shouldNotify");
  });

  it("ranks an exact token above a stem-only match", () => {
    const dir = makeTempProject({
      "src/exact.ts": `export function alerts(): void {\n  return;\n}\n`,
      "src/stem.ts": `export function alertManager(): void {\n  return;\n}\n`,
    });
    const tools = createTools(buildIndex(buildProject(dir)));
    // "alerts" names the first symbol exactly and stems the second's "alert".
    const data = okData(tools.search_symbols({ query: "alerts" }));
    expect(data.results.map((r) => r.name)).toEqual(["alerts", "alertManager"]);
    expect(data.results[0]?.match).toBe("name");
  });
});
