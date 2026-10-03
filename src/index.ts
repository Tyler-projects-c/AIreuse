import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import * as bundledTs from "typescript";

export type TypeScriptSource = "workspace" | "bundled";

export interface ResolvedTypeScript {
  ts: typeof bundledTs;
  source: TypeScriptSource;
  version: string;
}

export function resolveTypeScript(root: string): ResolvedTypeScript {
  const absRoot = path.resolve(root);
  try {
    const req = createRequire(path.join(absRoot, "package.json"));
    const ts = req("typescript") as typeof bundledTs;
    const version = typeof ts.version === "string" ? ts.version : "unknown";
    return { ts, source: "workspace", version };
  } catch {
    return { ts: bundledTs, source: "bundled", version: bundledTs.version };
  }
}

const DENIED_DIR_NAMES = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  ".next",
  "coverage",
  ".git",
]);

export function toForwardSlashes(p: string): string {
  return p.replace(/\\/g, "/");
}

export function toRepoRelative(absRoot: string, absPath: string): string {
  return toForwardSlashes(path.relative(absRoot, absPath));
}

/** Reason a repo-relative forward-slash path is denied, or null if allowed. */
export function deniedReason(relPath: string): string | null {
  const normalized = toForwardSlashes(relPath).replace(/^\.\//, "");
  const segments = normalized.split("/").filter((s) => s.length > 0);
  if (segments.length === 0) return null;
  for (const seg of segments) {
    if (DENIED_DIR_NAMES.has(seg)) return `dir:${seg}`;
  }
  const base = segments[segments.length - 1] as string;
  if (base.startsWith(".env")) return "env-file";
  if (base.endsWith(".pem")) return "pem-file";
  if (base.endsWith(".key")) return "key-file";
  return null;
}

/** Pure path-denylist check. Input must be repo-relative with forward slashes. */
export function isDeniedPath(relPath: string): boolean {
  return deniedReason(relPath) !== null;
}

export interface ProjectIndex {
  root: string;
  ts: typeof bundledTs;
  tsSource: TypeScriptSource;
  tsVersion: string;
  service: bundledTs.LanguageService;
  program: bundledTs.Program;
  files: string[];
  deniedByReason: Record<string, number>;
  skippedDirs: Record<string, number>;
  tsconfigPath: string | null;
  tsconfigWarning: string | null;
}

export interface BuildProjectOptions {
  tsconfig?: string;
}

const MAX_FILE_BYTES = 1024 * 1024;
const GENERATED_PROBE_BYTES = 2048;

function looksGenerated(head: Buffer): boolean {
  // Built dynamically so this source file does not itself contain the
  // marker and trip the generated-file denylist rule.
  const marker = "@" + "generated";
  return head.toString("utf8").includes(marker);
}

function classifyFile(absRoot: string, absFile: string): string | null {
  const rel = toRepoRelative(absRoot, absFile);
  const denied = deniedReason(rel);
  if (denied) return denied;
  if (/\.d\.[cm]?ts$/.test(absFile)) return "dts-file";
  try {
    if (fs.statSync(absFile).size > MAX_FILE_BYTES) return "too-large";
  } catch {
    return "unreadable";
  }
  try {
    const fd = fs.openSync(absFile, "r");
    try {
      const buf = Buffer.alloc(GENERATED_PROBE_BYTES);
      const n = fs.readSync(fd, buf, 0, GENERATED_PROBE_BYTES, 0);
      if (looksGenerated(buf.subarray(0, n))) return "generated-marker";
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "unreadable";
  }
  return null;
}

function listGitVisibleFiles(absRoot: string): Set<string> | null {
  try {
    const out: Buffer = execFileSync(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { cwd: absRoot, stdio: ["ignore", "pipe", "ignore"] },
    );
    const visible = new Set<string>();
    const nul = String.fromCharCode(0);
    for (const entry of out.toString("utf8").split(nul)) {
      if (entry.length > 0) visible.add(toForwardSlashes(entry));
    }
    return visible;
  } catch {
    return null;
  }
}

export interface WalkResult {
  files: string[];
  skippedDirs: Record<string, number>;
}

function walkFiles(absRoot: string): WalkResult {
  const found: string[] = [];
  const skippedDirs: Record<string, number> = {};
  const stack: string[] = [absRoot];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (isDeniedPath(toRepoRelative(absRoot, abs))) {
          skippedDirs[entry.name] = (skippedDirs[entry.name] ?? 0) + 1;
        } else {
          stack.push(abs);
        }
      } else if (entry.isFile()) {
        found.push(abs);
      }
    }
  }
  return { files: found, skippedDirs };
}

export function buildProject(
  root: string,
  opts?: BuildProjectOptions,
): ProjectIndex {
  const absRoot = path.resolve(root);
  const resolved = resolveTypeScript(absRoot);
  const ts = resolved.ts;

  let tsconfigPath: string | null = null;
  let tsconfigWarning: string | null = null;
  let parsed: bundledTs.ParsedCommandLine | null = null;

  const explicit = opts?.tsconfig ? path.resolve(absRoot, opts.tsconfig) : null;
  const candidate = explicit ?? path.join(absRoot, "tsconfig.json");
  if (fs.existsSync(candidate)) {
    tsconfigPath = candidate;
    const loaded = ts.readConfigFile(candidate, (p) => fs.readFileSync(p, "utf8"));
    if (loaded.error) throw new Error(`Failed to read tsconfig: ${candidate}`);
    const raw = (loaded.config ?? {}) as Record<string, unknown>;
    const hasRefs = raw["references"] !== undefined;
    const files = raw["files"];
    const include = raw["include"];
    const hasFiles = Array.isArray(files) && files.length > 0;
    const hasInclude = Array.isArray(include) && include.length > 0;
    if (hasRefs && !hasFiles && !hasInclude) {
      tsconfigWarning =
        "tsconfig only has \"references\" and no files/include; " +
        "using default options with walked files.";
      parsed = null;
    } else {
      parsed = ts.parseJsonConfigFileContent(
        loaded.config,
        ts.sys,
        path.dirname(candidate),
      );
    }
  } else if (explicit) {
    throw new Error(`tsconfig not found: ${candidate}`);
  }

  const { files: walked, skippedDirs } = walkFiles(absRoot);
  const deniedByReason: Record<string, number> = {};
  const gitVisible = listGitVisibleFiles(absRoot);
  // Only TS/JS source files are candidates for the index. Other file
  // types (docs, configs, lockfiles, ...) are skipped silently and do
  // not count as denied.
  const SOURCE_EXTS = new Set([
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mts",
    ".cts",
    ".mjs",
    ".cjs",
  ]);
  const candidateFiles: string[] = [];
  for (const abs of walked) {
    if (!SOURCE_EXTS.has(path.extname(abs).toLowerCase())) continue;
    const rel = toRepoRelative(absRoot, abs);
    const reason = classifyFile(absRoot, abs);
    if (reason) {
      deniedByReason[reason] = (deniedByReason[reason] ?? 0) + 1;
      continue;
    }
    if (gitVisible !== null && !gitVisible.has(rel)) {
      deniedByReason["gitignored"] = (deniedByReason["gitignored"] ?? 0) + 1;
      continue;
    }
    candidateFiles.push(abs);
  }

  let rootNames: string[];
  let options: bundledTs.CompilerOptions;
  if (parsed) {
    options = parsed.options;
    const parsedSet = new Set(parsed.fileNames.map((f) => path.resolve(f)));
    const kept: string[] = [];
    for (const f of candidateFiles) {
      if (parsedSet.has(path.resolve(f))) {
        kept.push(f);
      } else {
        deniedByReason["not-in-tsconfig"] =
          (deniedByReason["not-in-tsconfig"] ?? 0) + 1;
      }
    }
    if (kept.length > 0) {
      rootNames = kept;
    } else {
      tsconfigWarning =
        "tsconfig matched no source files; indexing all walked source files.";
      rootNames = candidateFiles;
    }
  } else {
    options = {
      allowJs: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
    };
    rootNames = candidateFiles;
  }

  const files = rootNames
    .map((f) => toRepoRelative(absRoot, f))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const absByRel = new Map<string, string>();
  for (const abs of rootNames) absByRel.set(toRepoRelative(absRoot, abs), abs);

  const host: bundledTs.LanguageServiceHost = {
    getCompilationSettings: () => options,
    getScriptFileNames: () => [...absByRel.values()],
    getScriptVersion: () => "1",
    getScriptSnapshot: (fileName) => {
      if (!fs.existsSync(fileName)) return undefined;
      return ts.ScriptSnapshot.fromString(fs.readFileSync(fileName, "utf8"));
    },
    getCurrentDirectory: () => absRoot,
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    fileExists: (f) => fs.existsSync(f),
    readFile: (f) => {
      try {
        return fs.readFileSync(f, "utf8");
      } catch {
        return undefined;
      }
    },
    readDirectory: ts.sys.readDirectory,
    directoryExists: (d) => {
      try {
        return fs.statSync(d).isDirectory();
      } catch {
        return false;
      }
    },
    getDirectories: ts.sys.getDirectories,
  };

  const service = ts.createLanguageService(host, ts.createDocumentRegistry());
  const program = service.getProgram();
  if (!program) throw new Error("Failed to create TypeScript program");

  return {
    root: absRoot,
    ts,
    tsSource: resolved.source,
    tsVersion: resolved.version,
    service,
    program,
    files,
    deniedByReason,
    skippedDirs,
    tsconfigPath,
    tsconfigWarning,
  };
}
