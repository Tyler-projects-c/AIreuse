import { describe, expect, it } from "vitest";
import { buildIndex, buildProject } from "../src/index.js";
import {
  SearchSymbolsInputSchema,
  type ResultEnvelope,
  type SearchSymbolsOutput,
} from "../src/schemas.js";
import { createTools } from "../src/tools.js";
import { makeTempProject } from "./helpers.js";

// 14 symbols in one file: more than the 10-result `limit` cap, so the whole
// file is only reachable by paging.
const MANY_TS = `${Array.from({ length: 14 }, (_, i) => {
  const n = String(i + 1).padStart(2, "0");
  return [
    `/** Handles item ${n}. */`,
    `export function item${n}(): void {`,
    "  return;",
    "}",
  ].join("\n");
}).join("\n\n")}\n`;

// One symbol, used to prove the offset applies after the `file` filter.
const OTHER_TS = `export function helperThing(): void {\n  return;\n}\n`;

// 25 functions, each with a 14-parameter signature (capped to 300 chars) and a
// >200-char first JSDoc sentence, so a page of 10 serializes past the 6144-byte
// cap and must be trimmed to a shorter page.
const LONG_DOC =
  "Processes the incoming payload with all of the configured validation, " +
  "normalization, logging and auditing steps that the surrounding pipeline " +
  "requires before the record is written back to the permanent database store";
const FAT_PARAMS = Array.from(
  { length: 14 },
  (_, i) => `parameterNumber${String(i + 1).padStart(2, "0")}: number`,
).join(", ");
const FAT_TS = `${Array.from({ length: 25 }, (_, i) => {
  const n = String(i + 1).padStart(2, "0");
  return [
    `/** ${LONG_DOC} */`,
    `export function fat${n}(${FAT_PARAMS}): void {`,
    "  return;",
    "}",
  ].join("\n");
}).join("\n\n")}\n`;

function buildFixture(): {
  dir: string;
  tools: ReturnType<typeof createTools>;
} {
  const dir = makeTempProject({
    "app/many.ts": MANY_TS,
    "src/other.ts": OTHER_TS,
    "src/fat.ts": FAT_TS,
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

const ITEM_NAMES = Array.from(
  { length: 14 },
  (_, i) => `item${String(i + 1).padStart(2, "0")}`,
);
const FAT_NAMES = Array.from(
  { length: 25 },
  (_, i) => `fat${String(i + 1).padStart(2, "0")}`,
);

describe("search_symbols offset pagination", () => {
  it("parses an omitted offset as 0 in the input schema", () => {
    expect(SearchSymbolsInputSchema.parse({ query: "item" })).toMatchObject({
      offset: 0,
    });
    expect(
      SearchSymbolsInputSchema.parse({ query: "item", offset: 4 }),
    ).toMatchObject({ offset: 4 });
  });

  it("defaults offset to 0, so the first page starts at rank 1", () => {
    // Parsing directly is covered in test/schemas.test.ts; this pins the tool.
    const { tools } = buildFixture();
    const withOffset = tools.search_symbols({ query: "item", offset: 0 });
    const without = tools.search_symbols({ query: "item" });
    // Default limit stays 5, and both forms return the same first page.
    expect(okData(withOffset).results.map((r) => r.name)).toEqual(
      ITEM_NAMES.slice(0, 5),
    );
    expect(okData(without).results.map((r) => r.name)).toEqual(
      ITEM_NAMES.slice(0, 5),
    );
    expect(okData(withOffset).truncated).toBe(true);
  });

  it("omitting offset is byte-identical to offset: 0", () => {
    const { tools } = buildFixture();
    const omitted = tools.search_symbols({ query: "item", limit: 7 });
    const zero = tools.search_symbols({ query: "item", limit: 7, offset: 0 });
    expect(JSON.stringify(omitted)).toBe(JSON.stringify(zero));
    const omittedFile = tools.search_symbols({ file: "app/many.ts" });
    const zeroFile = tools.search_symbols({ file: "app/many.ts", offset: 0 });
    expect(JSON.stringify(omittedFile)).toBe(JSON.stringify(zeroFile));
  });

  it("an unscoped envelope still has exactly results and truncated", () => {
    const { tools } = buildFixture();
    const data = okData(tools.search_symbols({ query: "item", offset: 3 }));
    expect(Object.keys(data).sort()).toEqual(["results", "truncated"]);
  });

  it("lists a 14-symbol file in pages of 5", () => {
    const { tools } = buildFixture();
    const first = okData(
      tools.search_symbols({ file: "app/many.ts", limit: 5 }),
    );
    expect(first.results.map((r) => r.name)).toEqual(ITEM_NAMES.slice(0, 5));
    expect(first.truncated).toBe(true);
    const second = okData(
      tools.search_symbols({ file: "app/many.ts", limit: 5, offset: 5 }),
    );
    expect(second.results.map((r) => r.name)).toEqual(ITEM_NAMES.slice(5, 10));
    expect(second.truncated).toBe(true);
  });

  it("two pages of 10 enumerate all 14 with no duplicates", () => {
    const { tools } = buildFixture();
    const page1 = okData(tools.search_symbols({ file: "app/many.ts", limit: 10 }));
    expect(page1.truncated).toBe(true);
    expect(page1.results.map((r) => r.name)).toEqual(ITEM_NAMES.slice(0, 10));
    const page2 = okData(
      tools.search_symbols({
        file: "app/many.ts",
        limit: 10,
        offset: page1.results.length,
      }),
    );
    expect(page2.truncated).toBe(false);
    expect(page2.results.map((r) => r.name)).toEqual(ITEM_NAMES.slice(10));
    const collected = [
      ...page1.results.map((r) => r.name),
      ...page2.results.map((r) => r.name),
    ];
    expect(collected).toEqual(ITEM_NAMES);
    expect(new Set(collected).size).toBe(14);
  });

  it("pages of 3 loop to the end and equal the full ordered list", () => {
    const { tools } = buildFixture();
    const collected: string[] = [];
    let offset = 0;
    for (let guard = 0; guard < 20; guard++) {
      const data = okData(
        tools.search_symbols({ file: "app/many.ts", limit: 3, offset }),
      );
      if (data.results.length === 0) break;
      collected.push(...data.results.map((r) => r.name));
      offset += data.results.length;
    }
    expect(collected).toEqual(ITEM_NAMES);
  });

  it("is not truncated when a page ends exactly at the last match", () => {
    const { tools } = buildFixture();
    const data = okData(
      tools.search_symbols({ file: "app/many.ts", limit: 10, offset: 4 }),
    );
    expect(data.results.map((r) => r.name)).toEqual(ITEM_NAMES.slice(4));
    expect(data.results).toHaveLength(10);
    expect(data.truncated).toBe(false);
  });

  it("returns nothing and no truncation at or past the end", () => {
    const { tools } = buildFixture();
    for (const offset of [14, 10000]) {
      const data = okData(
        tools.search_symbols({ file: "app/many.ts", limit: 5, offset }),
      );
      expect(data.results, `offset ${offset}`).toEqual([]);
      expect(data.truncated, `offset ${offset}`).toBe(false);
    }
  });

  it("paginates the ranked term query the same as one big page", () => {
    const { tools } = buildFixture();
    const full = okData(
      tools.search_symbols({ query: "item", limit: 10, offset: 0 }),
    );
    const tail = okData(
      tools.search_symbols({
        query: "item",
        limit: 10,
        offset: full.results.length,
      }),
    );
    const bigPage = [
      ...full.results.map((r) => r.name),
      ...tail.results.map((r) => r.name),
    ];
    const byFour: string[] = [];
    let offset = 0;
    for (let guard = 0; guard < 20; guard++) {
      const data = okData(
        tools.search_symbols({ query: "item", limit: 4, offset }),
      );
      if (data.results.length === 0) break;
      byFour.push(...data.results.map((r) => r.name));
      offset += data.results.length;
    }
    expect(byFour).toEqual(bigPage);
    expect(byFour).toEqual(ITEM_NAMES);
  });

  it("keeps file_filter_matched_files on every page, even past the end", () => {
    const { tools } = buildFixture();
    for (const offset of [0, 5, 10, 14, 10000]) {
      const data = okData(
        tools.search_symbols({ file: "app/many.ts", limit: 5, offset }),
      );
      expect(data.file_filter_matched_files, `offset ${offset}`).toBe(1);
    }
  });

  it("applies the offset after the file filter", () => {
    const { tools } = buildFixture();
    const first = okData(
      tools.search_symbols({ file: "src/other.ts", offset: 0 }),
    );
    expect(first.results.map((r) => r.name)).toEqual(["helperThing"]);
    const past = okData(
      tools.search_symbols({ file: "src/other.ts", offset: 1 }),
    );
    expect(past.results).toEqual([]);
    expect(past.truncated).toBe(false);
  });

  it("returns short truncated pages when the 6 KB cap trims them", () => {
    const { tools } = buildFixture();
    const collected: string[] = [];
    let offset = 0;
    let sawShortTruncatedPage = false;
    for (let guard = 0; guard < 50; guard++) {
      const data = okData(
        tools.search_symbols({ file: "src/fat.ts", limit: 10, offset }),
      );
      if (data.results.length === 0) break;
      if (data.truncated && data.results.length < 10) {
        sawShortTruncatedPage = true;
      }
      collected.push(...data.results.map((r) => r.name));
      offset += data.results.length;
    }
    expect(sawShortTruncatedPage).toBe(true);
    expect(collected).toEqual(FAT_NAMES);
  });

  it("rejects a negative, fractional or string offset", () => {
    const { tools } = buildFixture();
    for (const offset of [-1, 1.5, "2"]) {
      const env = tools.search_symbols({ query: "item", offset });
      expect(env.ok, `offset ${String(offset)}`).toBe(false);
      if (!env.ok) expect(env.error.code).toBe("INVALID_ARGS");
    }
    const limitEnv = tools.search_symbols({ query: "item", limit: 11 });
    expect(limitEnv.ok).toBe(false);
    if (!limitEnv.ok) expect(limitEnv.error.code).toBe("INVALID_ARGS");
  });
});
