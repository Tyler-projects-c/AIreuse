import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../src/cli.js";
import type { CliIo } from "../src/cli.js";
import { makeTempProject } from "./helpers.js";

const ADD_TS = [
  "/** Adds two numbers. */",
  "export function add(a: number, b: number): number {",
  "  return a + b;",
  "}",
  "",
].join("\n");

// Built once; run() rebuilds the index each call, so reuse keeps the file fast.
const projectDir = makeTempProject({ "src/math.ts": ADD_TS });
const emptyDir = makeTempProject({ "README.md": "# no TypeScript here\n" });
const missingDir = path.join(
  os.tmpdir(),
  `aireuse-missing-${process.pid}-${Date.now()}`,
);

function runCli(argv: string[]): {
  code: number;
  out: string[];
  err: string[];
} {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    out: (s) => out.push(s),
    err: (s) => err.push(s),
  };
  const code = run(argv, io);
  return { code, out, err };
}

describe("cli run", () => {
  it("returns 0 and prints search results", () => {
    const { code, out, err } = runCli(["search", "add", "--root", projectDir]);
    expect(code).toBe(0);
    expect(err).toEqual([]);
    expect(out.join("\n")).toContain("add");
  });

  it("returns 0 and exactly one JSON line for a --json success", () => {
    const { code, out, err } = runCli([
      "search",
      "add",
      "--json",
      "--root",
      projectDir,
    ]);
    expect(code).toBe(0);
    expect(err).toEqual([]);
    expect(out).toHaveLength(1);
    const parsed = JSON.parse(out[0] as string) as {
      ok: boolean;
      data: { results: unknown[] };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.data.results.length).toBeGreaterThan(0);
  });

  it("returns 1 with a one-line stderr error for an unknown symbol", () => {
    const { code, out, err } = runCli([
      "def",
      "s_9999",
      "--root",
      projectDir,
    ]);
    expect(code).toBe(1);
    expect(out).toEqual([]);
    expect(err).toHaveLength(1);
    expect(err[0]?.startsWith("error: ")).toBe(true);
    expect(err[0]).not.toContain("\n");
    expect(err.join("")).not.toMatch(/\bat .*:\d+:\d+/);
  });

  it("returns 1 and one JSON error envelope for a --json tool error", () => {
    const { code, out, err } = runCli([
      "def",
      "s_9999",
      "--json",
      "--root",
      projectDir,
    ]);
    expect(code).toBe(1);
    expect(err).toEqual([]);
    expect(out).toHaveLength(1);
    const parsed = JSON.parse(out[0] as string) as {
      ok: boolean;
      error: { code: string };
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("UNKNOWN_SYMBOL");
  });

  it("returns 2 for a missing symbol_id", () => {
    const { code, err } = runCli(["def", "--root", projectDir]);
    expect(code).toBe(2);
    expect(err.join("\n")).toContain("symbol_id");
  });

  it("returns 2 for an extra positional", () => {
    const { code, err } = runCli(["def", "s_1", "extra", "--root", projectDir]);
    expect(code).toBe(2);
    expect(err.join("\n")).toContain("extra");
  });

  it("returns 2 for an unknown command", () => {
    const { code, err } = runCli(["bogus", "--root", projectDir]);
    expect(code).toBe(2);
    expect(err.join("\n")).toContain("unknown command: bogus");
  });

  it("returns 2 with a friendly message for an unknown flag", () => {
    const { code, err } = runCli([
      "search",
      "add",
      "--bogus",
      "--root",
      projectDir,
    ]);
    expect(code).toBe(2);
    expect(err).toEqual(["error: unknown option: --bogus"]);
    expect(err.join("")).not.toContain("To specify a positional");
  });

  it("returns 2 for a non-numeric --limit", () => {
    const { code, err } = runCli([
      "search",
      "add",
      "--limit",
      "abc",
      "--root",
      projectDir,
    ]);
    expect(code).toBe(2);
    expect(err.join("\n")).toContain("--limit");
  });

  it("returns 2 for --limit 0", () => {
    const { code, err } = runCli([
      "search",
      "add",
      "--limit",
      "0",
      "--root",
      projectDir,
    ]);
    expect(code).toBe(2);
    expect(err.join("\n")).toContain("--limit");
  });

  it("returns 2 for a bad --kinds value", () => {
    const { code, err } = runCli([
      "refs",
      "s_1",
      "--kinds",
      "nope",
      "--root",
      projectDir,
    ]);
    expect(code).toBe(2);
    expect(err.join("\n")).toContain("--kinds");
  });

  it("emits one USAGE JSON line for a usage error with --json", () => {
    const { code, out, err } = runCli([
      "search",
      "add",
      "--limit",
      "abc",
      "--json",
      "--root",
      projectDir,
    ]);
    expect(code).toBe(2);
    expect(err).toEqual([]);
    expect(out).toHaveLength(1);
    const parsed = JSON.parse(out[0] as string) as {
      ok: boolean;
      error: { code: string; message: string };
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("USAGE");
    expect(parsed.error.message.length).toBeGreaterThan(0);
  });

  it("returns 1 for a missing --root directory", () => {
    const { code, err } = runCli(["stats", "--root", missingDir]);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("root directory not found");
  });

  it("returns 1 for a root with no TypeScript files", () => {
    const { code, err } = runCli(["stats", "--root", emptyDir]);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("no TypeScript files");
  });

  it("prints usage to out and returns 0 for --help", () => {
    const { code, out, err } = runCli(["--help"]);
    expect(code).toBe(0);
    expect(err).toEqual([]);
    expect(out.join("\n")).toContain("Usage:");
  });

  it("prints usage to err and returns 2 when no command is given", () => {
    const { code, out, err } = runCli([]);
    expect(code).toBe(2);
    expect(out).toEqual([]);
    expect(err.join("\n")).toContain("Usage:");
  });

  it("accepts relative, trailing-slash, forward- and back-slash roots", () => {
    const relative = path.relative(process.cwd(), projectDir);
    const variants = [
      relative,
      `${projectDir}${path.sep}`,
      projectDir.replace(/\\/g, "/"),
      projectDir.replace(/\//g, "\\"),
    ];
    for (const root of variants) {
      const { code } = runCli(["stats", "--root", root]);
      expect(code, `root ${root}`).toBe(0);
    }
  });
});
