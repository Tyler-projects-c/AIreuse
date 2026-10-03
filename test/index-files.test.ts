import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildProject,
  isDeniedPath,
  resolveTypeScript,
  toForwardSlashes,
} from "../src/index.js";
import { makeTempProject } from "./helpers.js";

function gitAvailable(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function linkWorkspaceTypeScript(dir: string): void {
  const src = path.resolve("node_modules/typescript");
  const destDir = path.join(dir, "node_modules");
  fs.mkdirSync(destDir, { recursive: true });
  fs.symlinkSync(src, path.join(destDir, "typescript"), "junction");
}

describe("denylist paths", () => {
  it("denies vendor/output/secret paths", () => {
    for (const p of [
      "node_modules/a.ts",
      "src/node_modules/x.ts",
      "dist/a.js",
      "build/a.js",
      "out/a.js",
      ".next/a.js",
      "coverage/a.js",
      ".git/config",
      ".env",
      ".env.local",
      "config.pem",
      "deep/dir/key.key",
      "sub/dist/b.ts",
    ]) {
      expect(isDeniedPath(p), p).toBe(true);
    }
  });

  it("allows normal source paths", () => {
    for (const p of ["src/a.ts", "test/a.test.ts", "a.ts", "docs/note.md"]) {
      expect(isDeniedPath(p), p).toBe(false);
    }
  });
});

describe("buildProject files", () => {
  it("excludes denied and generated content", () => {
    const big = "x".repeat(1024 * 1024 + 1);
    // Built dynamically so this test file does not itself contain the
    // generated-file marker in its first 2KB and get excluded itself.
    const marker = "@" + "generated";
    const dir = makeTempProject({
      "src/ok.ts": "export const a = 1;\n",
      "node_modules/skip.ts": "export const s = 1;\n",
      "dist/skip.ts": "export const s = 1;\n",
      ".env": "SECRET=1\n",
      "key.pem": "pem\n",
      "secret.key": "key\n",
      "types.d.ts": "export declare const d: number;\n",
      "big.ts": big,
      ["gen.ts"]: `// ${marker}\nexport const g = 1;\n`,
    });
    const project = buildProject(dir);
    expect(project.files).toContain("src/ok.ts");
    expect(project.files).not.toContain("node_modules/skip.ts");
    expect(project.files).not.toContain("dist/skip.ts");
    expect(project.files).not.toContain(".env");
    expect(project.files).not.toContain("key.pem");
    expect(project.files).not.toContain("secret.key");
    expect(project.files).not.toContain("types.d.ts");
    expect(project.files).not.toContain("big.ts");
    expect(project.files).not.toContain("gen.ts");
    for (const f of project.files) {
      expect(path.isAbsolute(f)).toBe(false);
      expect(f).not.toContain("\\");
      expect(f).toBe(toForwardSlashes(f));
    }
  });

  it.skipIf(!gitAvailable())("excludes gitignored files when git repo", () => {
    const dir = makeTempProject(
      {
        "src/ok.ts": "export const a = 1;\n",
        "src/ignored.ts": "export const b = 2;\n",
        ".gitignore": "src/ignored.ts\n",
      },
      { git: true },
    );
    const project = buildProject(dir);
    expect(project.files).toContain("src/ok.ts");
    expect(project.files).not.toContain("src/ignored.ts");
  });

  it("prefers workspace typescript via junction", () => {
    const dir = makeTempProject({
      "src/ok.ts": "export const a = 1;\n",
      "package.json": '{"name":"tmp"}',
    });
    linkWorkspaceTypeScript(dir);
    const viaResolve = resolveTypeScript(dir);
    expect(viaResolve.source).toBe("workspace");
    const project = buildProject(dir);
    expect(project.tsSource).toBe("workspace");
  });

  it("falls back to bundled typescript", () => {
    const dir = makeTempProject({
      "src/ok.ts": "export const a = 1;\n",
    });
    const viaResolve = resolveTypeScript(dir);
    expect(viaResolve.source).toBe("bundled");
    const project = buildProject(dir);
    expect(project.tsSource).toBe("bundled");
    expect(project.tsVersion.length).toBeGreaterThan(0);
  });

  it("honors an explicit tsconfig path", () => {
    const dir = makeTempProject({
      "src/kept.ts": "export const a = 1;\n",
      "other/extra.ts": "export const b = 2;\n",
      "custom.json": JSON.stringify({
        compilerOptions: { strict: true },
        include: ["src/**/*"],
      }),
    });
    const project = buildProject(dir, { tsconfig: "custom.json" });
    expect(project.tsconfigPath?.endsWith("custom.json")).toBe(true);
    expect(project.files).toContain("src/kept.ts");
    expect(project.files).not.toContain("other/extra.ts");
    expect(project.deniedByReason["not-in-tsconfig"]).toBe(1);
  });

  it("throws for a missing explicit tsconfig", () => {
    const dir = makeTempProject({
      "src/ok.ts": "export const a = 1;\n",
    });
    expect(() => buildProject(dir, { tsconfig: "nope.json" })).toThrow(
      /tsconfig not found/,
    );
  });

  it("warns on references-only tsconfig and indexes walked files", () => {
    const dir = makeTempProject({
      "src/ok.ts": "export const a = 1;\n",
      "tsconfig.json": JSON.stringify({ references: [{ path: "./other" }] }),
    });
    const project = buildProject(dir);
    expect(project.tsconfigWarning).toMatch(/references/);
    expect(project.files).toContain("src/ok.ts");
  });

  it("counts source files outside the tsconfig as not-in-tsconfig", () => {
    const dir = makeTempProject({
      "src/kept.ts": "export const a = 1;\n",
      "other/outside.ts": "export const b = 2;\n",
      "tsconfig.json": JSON.stringify({ include: ["src/**/*"] }),
    });
    const project = buildProject(dir);
    expect(project.files).toContain("src/kept.ts");
    expect(project.files).not.toContain("other/outside.ts");
    expect(project.deniedByReason["not-in-tsconfig"]).toBe(1);
  });

  it.skipIf(!gitAvailable())("keeps non-ascii filenames in git repos", () => {
    const dir = makeTempProject(
      {
        "src/ok.ts": "export const a = 1;\n",
        "src/é.ts": "export const e = 1;\n",
      },
      { git: true },
    );
    execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "ignore" });
    const project = buildProject(dir);
    expect(project.files).toContain("src/é.ts");
    expect(project.deniedByReason["gitignored"] ?? 0).toBe(0);
  });

  it("excludes .d.mts as dts-file", () => {
    const dir = makeTempProject({
      "src/ok.ts": "export const a = 1;\n",
      "types.d.mts": "export declare const d: number;\n",
    });
    const project = buildProject(dir);
    expect(project.files).toContain("src/ok.ts");
    expect(project.files).not.toContain("types.d.mts");
    expect(project.deniedByReason["dts-file"]).toBe(1);
  });

  it("reports skipped node_modules directory", () => {
    const dir = makeTempProject({
      "src/ok.ts": "export const a = 1;\n",
      "node_modules/skip.ts": "export const s = 1;\n",
      "src/node_modules/x.ts": "export const x = 1;\n",
    });
    const project = buildProject(dir);
    expect(project.skippedDirs["node_modules"]).toBe(2);
    expect(project.files).not.toContain("node_modules/skip.ts");
    expect(project.files).not.toContain("src/node_modules/x.ts");
  });

  it("clears not-in-tsconfig when tsconfig matches nothing", () => {
    const dir = makeTempProject({
      "src/a.ts": "export const a = 1;\n",
      "src/b.ts": "export const b = 2;\n",
      "tsconfig.json": JSON.stringify({ include: ["nowhere/**/*"] }),
    });
    const project = buildProject(dir);
    expect(project.tsconfigWarning).toMatch(/matched no source files/);
    expect(project.files).toContain("src/a.ts");
    expect(project.files).toContain("src/b.ts");
    expect("not-in-tsconfig" in project.deniedByReason).toBe(false);
  });
});
