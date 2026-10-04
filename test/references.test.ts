import { describe, expect, it } from "vitest";
import { buildIndex, buildProject, toForwardSlashes } from "../src/index.js";
import type { GetReferencesOutput, ResultEnvelope } from "../src/schemas.js";
import { GetReferencesOutputSchema } from "../src/schemas.js";
import { createTools } from "../src/tools.js";
import { makeTempProject } from "./helpers.js";

const LIB_SRC = `export function ping(n: number): number {
  return n;
}
`;

const MAIN_SRC = `import { ping } from "./lib";

export function callPing(): number {
  return ping(1);
}

export const pingRef = ping;

export type PingType = typeof ping;
`;

const LIB_TEST_SRC = `import { ping } from "./lib";

export function pingTwice(): number {
  return ping(2);
}
`;

// Built dynamically so this test source contains no token-shaped literal.
const SECRET = "AKIA" + "ABCDEFGH01234567";

const SECRET_SRC = `export function ingest(x: number): number {
  return x;
}

export function leaky(): number {
  return ingest(1) + "${SECRET}".length;
}
`;

const LONG_CALL = " + 0".repeat(80);

const LONG_SRC = `export function base(x: number): number {
  return x;
}

export function longUse(): number {
  return base(1)${LONG_CALL};
}
`;

const mainDir = makeTempProject({
  "src/lib.ts": LIB_SRC,
  "src/main.ts": MAIN_SRC,
  "src/lib.test.ts": LIB_TEST_SRC,
});
const mainIndex = buildIndex(buildProject(mainDir));
const mainTools = createTools(mainIndex);

function idOf(name: string, file: string): string {
  const sym = mainIndex.all().find((s) => s.name === name && s.file === file);
  if (!sym) throw new Error(`symbol not found: ${name} in ${file}`);
  return sym.symbol_id;
}

function okRefs(env: ResultEnvelope): GetReferencesOutput {
  if (!env.ok) {
    throw new Error(`expected ok envelope: ${JSON.stringify(env)}`);
  }
  const data = env.data as GetReferencesOutput;
  GetReferencesOutputSchema.parse(data);
  return data;
}

describe("get_references", () => {
  it("classifies every reference and excludes the definition", () => {
    const data = okRefs(
      mainTools.get_references({ symbol_id: idOf("ping", "src/lib.ts") }),
    );
    expect(data.total).toBe(4);
    expect(data.truncated).toBe(false);
    expect(data.by_file).toEqual([{ file: "src/main.ts", count: 4 }]);
    expect(data.references).toEqual([
      {
        file: "src/main.ts",
        line: 1,
        kind: "import",
        enclosing_symbol_id: null,
        context: 'import { ping } from "./lib";',
      },
      {
        file: "src/main.ts",
        line: 4,
        kind: "call",
        enclosing_symbol_id: idOf("callPing", "src/main.ts"),
        context: "return ping(1);",
      },
      {
        file: "src/main.ts",
        line: 7,
        kind: "other",
        enclosing_symbol_id: idOf("pingRef", "src/main.ts"),
        context: "export const pingRef = ping;",
      },
      {
        file: "src/main.ts",
        line: 9,
        kind: "type_use",
        enclosing_symbol_id: idOf("PingType", "src/main.ts"),
        context: "export type PingType = typeof ping;",
      },
    ]);
  });

  it("hides references located in test files unless include_tests", () => {
    const hidden = okRefs(
      mainTools.get_references({ symbol_id: idOf("ping", "src/lib.ts") }),
    );
    expect(hidden.total).toBe(4);

    const shown = okRefs(
      mainTools.get_references({
        symbol_id: idOf("ping", "src/lib.ts"),
        include_tests: true,
      }),
    );
    expect(shown.total).toBe(6);
    expect(shown.by_file_truncated).toBe(false);
    expect(shown.by_file).toEqual([
      { file: "src/main.ts", count: 4 },
      { file: "src/lib.test.ts", count: 2 },
    ]);
    expect(shown.references.map((r) => r.file)).toContain("src/lib.test.ts");
  });

  it("filters by kind", () => {
    const calls = okRefs(
      mainTools.get_references({
        symbol_id: idOf("ping", "src/lib.ts"),
        kinds: ["call"],
      }),
    );
    expect(calls.total).toBe(1);
    expect(calls.references.map((r) => [r.file, r.line, r.kind])).toEqual([
      ["src/main.ts", 4, "call"],
    ]);

    const two = okRefs(
      mainTools.get_references({
        symbol_id: idOf("ping", "src/lib.ts"),
        kinds: ["import", "type_use"],
      }),
    );
    expect(two.references.map((r) => r.kind)).toEqual(["import", "type_use"]);
  });

  it("applies the limit and marks truncation", () => {
    const data = okRefs(
      mainTools.get_references({
        symbol_id: idOf("ping", "src/lib.ts"),
        limit: 1,
      }),
    );
    expect(data.references).toHaveLength(1);
    expect(data.truncated).toBe(true);
    expect(data.total).toBe(4);
  });

  it("maps unknown and malformed ids to error envelopes", () => {
    const unknown = mainTools.get_references({ symbol_id: "s_9999" });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.code).toBe("UNKNOWN_SYMBOL");

    const malformed = mainTools.get_references({ symbol_id: "x" });
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.error.code).toBe("INVALID_ARGS");
  });

  it("rejects malformed input without throwing", () => {
    for (const bad of [null, "str", 42, undefined, true, []]) {
      const env = mainTools.get_references(bad);
      expect(env.ok, String(bad)).toBe(false);
      if (!env.ok) expect(env.error.code).toBe("INVALID_ARGS");
    }
    const unknownKey = mainTools.get_references({
      symbol_id: idOf("ping", "src/lib.ts"),
      bogus: 1,
    });
    expect(unknownKey.ok).toBe(false);
    if (!unknownKey.ok) expect(unknownKey.error.code).toBe("INVALID_ARGS");
  });

  it("redacts secrets inside the context line", () => {
    const dir = makeTempProject({ "src/sec.ts": SECRET_SRC });
    const index = buildIndex(buildProject(dir));
    const tools = createTools(index);
    const sym = index.all().find((s) => s.name === "ingest");
    const data = okRefs(
      tools.get_references({ symbol_id: sym ? sym.symbol_id : "s_1" }),
    );
    expect(data.total).toBe(1);
    expect(data.references[0]?.kind).toBe("call");
    expect(data.references[0]?.context).toContain("[REDACTED]");
    expect(JSON.stringify(data)).not.toContain(SECRET);
  });

  it("caps the context line at 200 chars", () => {
    const dir = makeTempProject({ "src/long.ts": LONG_SRC });
    const index = buildIndex(buildProject(dir));
    const tools = createTools(index);
    const sym = index.all().find((s) => s.name === "base");
    const data = okRefs(
      tools.get_references({ symbol_id: sym ? sym.symbol_id : "s_1" }),
    );
    expect(data.total).toBe(1);
    const context = data.references[0]?.context ?? "";
    expect(context.length).toBe(200);
    expect(context.startsWith("return base(1)")).toBe(true);
  });

  it("never leaks the root and is deterministic", () => {
    const env = mainTools.get_references({
      symbol_id: idOf("ping", "src/lib.ts"),
      include_tests: true,
    });
    const serialized = JSON.stringify(env);
    for (const variant of [mainDir, toForwardSlashes(mainDir)]) {
      expect(serialized.toLowerCase()).not.toContain(variant.toLowerCase());
    }

    const first = mainTools.get_references({
      symbol_id: idOf("ping", "src/lib.ts"),
    });
    const second = mainTools.get_references({
      symbol_id: idOf("ping", "src/lib.ts"),
    });
    expect(second).toEqual(first);
  });

  it("rejects an empty kinds list", () => {
    const env = mainTools.get_references({
      symbol_id: idOf("ping", "src/lib.ts"),
      kinds: [],
    });
    expect(env.ok).toBe(false);
    if (!env.ok) expect(env.error.code).toBe("INVALID_ARGS");
  });

  it("treats call arguments and call results as other", () => {
    const dir = makeTempProject({
      "src/handler.ts": `export function handler(): void {}\n`,
      "src/app.ts": `import { handler } from "./handler";\n\nexport function boot(app: { use(h: unknown): { listen(): void } }): void {\n  app.use(handler).listen();\n}\n`,
      "src/lib.ts": LIB_SRC,
      "src/curried.ts": `import { ping } from "./lib";\n\ndeclare const foo: (f: (n: number) => number) => (n: number) => number;\n\nexport const r = foo(ping)(2);\n`,
    });
    const index = buildIndex(buildProject(dir));
    const tools = createTools(index);
    const id = (name: string, file: string): string => {
      const sym = index.all().find((s) => s.name === name && s.file === file);
      if (!sym) throw new Error(`symbol not found: ${name} in ${file}`);
      return sym.symbol_id;
    };

    const handlerRefs = okRefs(
      tools.get_references({ symbol_id: id("handler", "src/handler.ts") }),
    );
    expect(handlerRefs.references.map((r) => [r.line, r.kind])).toEqual([
      [1, "import"],
      [4, "other"],
    ]);

    const pingRefs = okRefs(
      tools.get_references({ symbol_id: id("ping", "src/lib.ts") }),
    );
    expect(pingRefs.references.map((r) => [r.line, r.kind])).toEqual([
      [1, "import"],
      [5, "other"],
    ]);
  });

  it("treats ns.ping(1) through a namespace import as call", () => {
    const dir = makeTempProject({
      "src/lib.ts": LIB_SRC,
      "src/ns.ts": `import * as ns from "./lib";\n\nexport function useNs(): number {\n  return ns.ping(1);\n}\n`,
    });
    const index = buildIndex(buildProject(dir));
    const tools = createTools(index);
    const sym = index
      .all()
      .find((s) => s.name === "ping" && s.file === "src/lib.ts");
    const data = okRefs(
      tools.get_references({ symbol_id: sym ? sym.symbol_id : "s_1" }),
    );
    expect(data.total).toBe(1);
    expect(data.references.map((r) => [r.line, r.kind])).toEqual([[4, "call"]]);
  });

  it("treats new Thing() as call", () => {
    const dir = makeTempProject({
      "src/thing.ts": `export class Thing {\n  constructor() {}\n}\n`,
      "src/use.ts": `import { Thing } from "./thing";\n\nexport const t = new Thing();\n`,
    });
    const index = buildIndex(buildProject(dir));
    const tools = createTools(index);
    const sym = index
      .all()
      .find((s) => s.name === "Thing" && s.file === "src/thing.ts");
    const data = okRefs(
      tools.get_references({ symbol_id: sym ? sym.symbol_id : "s_1" }),
    );
    expect(data.references.map((r) => [r.line, r.kind])).toEqual([
      [1, "import"],
      [3, "call"],
    ]);
  });

  it("caps by_file at 20 entries and stays within the byte budget", () => {
    const files: Record<string, string> = { "src/lib.ts": LIB_SRC };
    for (let i = 0; i < 60; i++) {
      const name = `f${String(i).padStart(2, "0")}`;
      files[`src/${name}.ts`] = `export { ping } from "./lib";\n`;
    }
    const dir = makeTempProject(files);
    const index = buildIndex(buildProject(dir));
    const tools = createTools(index);
    const sym = index
      .all()
      .find((s) => s.name === "ping" && s.file === "src/lib.ts");
    const env = tools.get_references({ symbol_id: sym ? sym.symbol_id : "s_1" });
    const data = okRefs(env);
    expect(data.total).toBe(60);
    expect(data.by_file.length).toBeLessThanOrEqual(20);
    expect(data.by_file_truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(env), "utf8")).toBeLessThanOrEqual(
      6144,
    );
  });
});
