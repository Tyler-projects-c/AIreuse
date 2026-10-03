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

  it("excludes gitignored files when git repo", () => {
    if (!gitAvailable()) return;
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
});
