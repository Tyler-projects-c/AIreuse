import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import * as bundledTs from "typescript";
import type { SymbolKind, SymbolSummary } from "./schemas.js";

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

export function isTestPath(relPath: string): boolean {
  const normalized = toForwardSlashes(relPath).replace(/^\.\//, "");
  const segments = normalized.split("/").filter((s) => s.length > 0);
  if (segments.length === 0) return false;
  for (const seg of segments) {
    if (seg === "__tests__" || seg === "test" || seg === "tests") return true;
  }
  const base = segments[segments.length - 1] as string;
  return /\.(test|spec)\./.test(base);
}

export type DeclarationNode =
  | bundledTs.FunctionDeclaration
  | bundledTs.VariableDeclaration
  | bundledTs.ClassDeclaration
  | bundledTs.MethodDeclaration
  | bundledTs.InterfaceDeclaration
  | bundledTs.TypeAliasDeclaration;

export interface RawSymbol {
  name: string;
  kind: SymbolKind;
  file: string;
  line: number;
  exported: boolean;
  is_test: boolean;
  doc_summary: string | null;
  startOffset: number;
  endOffset: number;
  nameOffset: number;
  declaration: DeclarationNode;
  rangeNode: bundledTs.Node;
}

function firstSentence(text: string): string {
  const raw = text.replace(/\r\n/g, "\n");
  let cut = raw.length;
  const dotSpace = raw.indexOf(". ");
  if (dotSpace !== -1) cut = Math.min(cut, dotSpace + 1);
  const dotNl = raw.indexOf(".\n");
  if (dotNl !== -1) cut = Math.min(cut, dotNl + 1);
  const para = raw.indexOf("\n\n");
  if (para !== -1) cut = Math.min(cut, para);
  let sentence = raw.slice(0, cut).replace(/\s+/g, " ").trim();
  // Redact before the 200-char cap so a cut never leaves half a secret.
  sentence = redactSecrets(sentence);
  if (sentence.length > 200) sentence = sentence.slice(0, 200);
  return sentence;
}

function jsDocText(
  ts: typeof bundledTs,
  node: bundledTs.Node,
): string | null {
  const jsDocs = (node as { jsDoc?: unknown }).jsDoc;
  if (!Array.isArray(jsDocs)) return null;
  const parts: string[] = [];
  for (const doc of jsDocs) {
    const comment = (doc as { comment?: unknown }).comment;
    if (typeof comment === "string") {
      parts.push(comment);
    } else if (Array.isArray(comment)) {
      parts.push(ts.displayPartsToString(comment));
    }
  }
  const text = parts.join(" ").trim();
  return text.length > 0 ? text : null;
}

function docSummaryFor(
  ts: typeof bundledTs,
  checker: bundledTs.TypeChecker,
  nameNode: bundledTs.Node,
  statement: bundledTs.Node,
  variableStatement: bundledTs.VariableStatement | null,
): string | null {
  let text: string | null = null;
  try {
    const sym = checker.getSymbolAtLocation(
      nameNode as bundledTs.DeclarationName,
    );
    if (sym) {
      const rendered = ts.displayPartsToString(
        sym.getDocumentationComment(checker),
      ).trim();
      if (rendered.length > 0) text = rendered;
    }
  } catch {
    text = null;
  }
  if (!text) {
    // Fallback: variable statements (const f = () => {}) often do not
    // surface their JSDoc through the checker symbol for the inner
    // VariableDeclaration, so read the statement's jsDoc directly.
    text =
      jsDocText(ts, statement) ??
      (variableStatement ? jsDocText(ts, variableStatement) : null);
  }
  if (!text) return null;
  return firstSentence(text);
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
      delete deniedByReason["not-in-tsconfig"];
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

function declarationLine(
  sourceFile: bundledTs.SourceFile,
  node: bundledTs.Node,
): number {
  const pos = node.getStart(sourceFile, false);
  return sourceFile.getLineAndCharacterOfPosition(pos).line + 1;
}

function unwrapParens(
  ts: typeof bundledTs,
  expr: bundledTs.Expression,
): bundledTs.Expression {
  let current = expr;
  while (ts.isParenthesizedExpression(current)) {
    current = current.expression;
  }
  return current;
}

function variableKind(
  ts: typeof bundledTs,
  decl: bundledTs.VariableDeclaration,
): SymbolKind {
  const init = decl.initializer;
  if (init) {
    const unwrapped = unwrapParens(ts, init);
    if (
      ts.isArrowFunction(unwrapped) ||
      ts.isFunctionExpression(unwrapped)
    ) {
      return "function";
    }
  }
  return "const";
}

function hasExportModifier(node: bundledTs.Node): boolean {
  const mods = (node as { modifiers?: readonly bundledTs.Modifier[] }).modifiers;
  if (!mods) return false;
  return mods.some(
    (m) =>
      m.kind === bundledTs.SyntaxKind.ExportKeyword ||
      m.kind === bundledTs.SyntaxKind.DefaultKeyword,
  );
}

interface FileExportNames {
  named: Set<string>;
  defaultNames: Set<string>;
}

function collectFileExportNames(
  ts: typeof bundledTs,
  sourceFile: bundledTs.SourceFile,
): FileExportNames {
  const named = new Set<string>();
  const defaultNames = new Set<string>();
  for (const stmt of sourceFile.statements) {
    if (ts.isExportDeclaration(stmt)) {
      // Re-exports (with moduleSpecifier) create no symbols.
      if (stmt.moduleSpecifier) continue;
      const clause = stmt.exportClause;
      if (clause && ts.isNamedExports(clause)) {
        for (const el of clause.elements) {
          named.add(el.propertyName ? el.propertyName.text : el.name.text);
        }
      }
    } else if (ts.isExportAssignment(stmt)) {
      if (!stmt.isExportEquals && ts.isIdentifier(stmt.expression)) {
        defaultNames.add(stmt.expression.text);
      }
    }
  }
  return { named, defaultNames };
}

function isSkippableMethod(
  ts: typeof bundledTs,
  member: bundledTs.MethodDeclaration,
): boolean {
  if (!member.name || !ts.isIdentifier(member.name)) return true;
  const text = member.name.text;
  if (text === "constructor") return true;
  if (ts.isGetAccessorDeclaration(member)) return true;
  if (ts.isSetAccessorDeclaration(member)) return true;
  const mods = member.modifiers ?? [];
  for (const m of mods) {
    if (m.kind === bundledTs.SyntaxKind.PrivateKeyword) return true;
  }
  if (text.startsWith("#")) return true;
  return false;
}

export function extractSymbols(project: ProjectIndex): RawSymbol[] {
  const ts = project.ts;
  const checker = project.program.getTypeChecker();
  const out: RawSymbol[] = [];
  const seenFirst = new Set<string>();
  const recordFirst = (key: string): boolean => {
    if (seenFirst.has(key)) return false;
    seenFirst.add(key);
    return true;
  };

  for (const rel of project.files) {
    const abs = path.join(project.root, rel);
    const sourceFile = project.program.getSourceFile(abs);
    if (!sourceFile) continue;
    const is_test = isTestPath(rel);
    const exports = collectFileExportNames(ts, sourceFile);

    for (const stmt of sourceFile.statements) {
      if (ts.isFunctionDeclaration(stmt)) {
        if (!stmt.name) continue;
        const name = stmt.name.text;
        if (!recordFirst(`fn:${rel}:${name}`)) continue;
        const exported =
          hasExportModifier(stmt) ||
          exports.named.has(name) ||
          exports.defaultNames.has(name);
        out.push({
          name,
          kind: "function",
          file: rel,
          line: declarationLine(sourceFile, stmt),
          exported,
          is_test,
          doc_summary: docSummaryFor(ts, checker, stmt.name, stmt, null),
          startOffset: stmt.getStart(sourceFile, false),
          endOffset: stmt.getEnd(),
          nameOffset: stmt.name.getStart(sourceFile, false),
          declaration: stmt,
          rangeNode: stmt,
        });
      } else if (ts.isVariableStatement(stmt)) {
        const stmtExported = hasExportModifier(stmt);
        for (const decl of stmt.declarationList.declarations) {
          if (!ts.isIdentifier(decl.name)) continue;
          const name = decl.name.text;
          if (!recordFirst(`var:${rel}:${name}`)) continue;
          out.push({
            name,
            kind: variableKind(ts, decl),
            file: rel,
            line: declarationLine(sourceFile, decl),
            exported:
              stmtExported ||
              exports.named.has(name) ||
              exports.defaultNames.has(name),
            is_test,
            doc_summary: docSummaryFor(ts, checker, decl.name, decl, stmt),
            startOffset: decl.getStart(sourceFile, false),
            endOffset: decl.getEnd(),
            nameOffset: decl.name.getStart(sourceFile, false),
            declaration: decl,
            rangeNode: stmt,
          });
        }
      } else if (ts.isClassDeclaration(stmt)) {
        if (!stmt.name) continue;
        const className = stmt.name.text;
        if (!recordFirst(`class:${rel}:${className}`)) continue;
        const classExported =
          hasExportModifier(stmt) ||
          exports.named.has(className) ||
          exports.defaultNames.has(className);
        out.push({
          name: className,
          kind: "class",
          file: rel,
          line: declarationLine(sourceFile, stmt),
          exported: classExported,
          is_test,
          doc_summary: docSummaryFor(ts, checker, stmt.name, stmt, null),
          startOffset: stmt.getStart(sourceFile, false),
          endOffset: stmt.getEnd(),
          nameOffset: stmt.name.getStart(sourceFile, false),
          declaration: stmt,
          rangeNode: stmt,
        });
        for (const member of stmt.members) {
          if (!ts.isMethodDeclaration(member)) continue;
          if (isSkippableMethod(ts, member)) continue;
          const mName = member.name as bundledTs.Identifier;
          const fullName = `${className}.${mName.text}`;
          if (!recordFirst(`method:${rel}:${fullName}`)) continue;
          out.push({
            name: fullName,
            kind: "method",
            file: rel,
            line: declarationLine(sourceFile, member),
            exported: classExported,
            is_test,
            doc_summary: docSummaryFor(
              ts,
              checker,
              member.name as bundledTs.Node,
              member,
              null,
            ),
            startOffset: member.getStart(sourceFile, false),
            endOffset: member.getEnd(),
            nameOffset: (
              member.name as bundledTs.Identifier
            ).getStart(sourceFile, false),
            declaration: member,
            rangeNode: member,
          });
        }
      } else if (ts.isInterfaceDeclaration(stmt)) {
        const name = stmt.name.text;
        if (!recordFirst(`iface:${rel}:${name}`)) continue;
        out.push({
          name,
          kind: "interface",
          file: rel,
          line: declarationLine(sourceFile, stmt),
          exported:
            hasExportModifier(stmt) ||
            exports.named.has(name) ||
            exports.defaultNames.has(name),
          is_test,
          doc_summary: docSummaryFor(ts, checker, stmt.name, stmt, null),
          startOffset: stmt.getStart(sourceFile, false),
          endOffset: stmt.getEnd(),
          nameOffset: stmt.name.getStart(sourceFile, false),
          declaration: stmt,
          rangeNode: stmt,
        });
      } else if (ts.isTypeAliasDeclaration(stmt)) {
        const name = stmt.name.text;
        if (!recordFirst(`type:${rel}:${name}`)) continue;
        out.push({
          name,
          kind: "type",
          file: rel,
          line: declarationLine(sourceFile, stmt),
          exported:
            hasExportModifier(stmt) ||
            exports.named.has(name) ||
            exports.defaultNames.has(name),
          is_test,
          doc_summary: docSummaryFor(ts, checker, stmt.name, stmt, null),
          startOffset: stmt.getStart(sourceFile, false),
          endOffset: stmt.getEnd(),
          nameOffset: stmt.name.getStart(sourceFile, false),
          declaration: stmt,
          rangeNode: stmt,
        });
      }
    }
  }

  out.sort((a, b) => {
    if (a.file < b.file) return -1;
    if (a.file > b.file) return 1;
    return a.startOffset - b.startOffset;
  });
  return out;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The checker renders imported module types as `typeof import("C:/abs/path/src/b")`.
 * Rewrite in-project absolute paths to import("./<relative>") and other absolute
 * paths to import("<external>"), then blank out any remaining project root.
 */
export function scrubPaths(text: string, absRoot: string): string {
  const root = toForwardSlashes(path.resolve(absRoot));
  const lowerRoot = root.toLowerCase();
  let out = text.replace(/import\("([^"]*)"\)/g, (_match, rawPath: string) => {
    const normalized = toForwardSlashes(rawPath);
    const lower = normalized.toLowerCase();
    if (lower === lowerRoot || lower.startsWith(`${lowerRoot}/`)) {
      const rel = normalized.slice(root.length).replace(/^\/+/, "");
      return `import("./${rel}")`;
    }
    if (/^[A-Za-z]:\//.test(normalized) || normalized.startsWith("/")) {
      return 'import("<external>")';
    }
    return `import("${normalized}")`;
  });
  if (root.length > 0) {
    const pattern = escapeRegExp(root).replace(/\//g, "[\\\\/]");
    out = out.replace(new RegExp(pattern, "gi"), ".");
  }
  return out;
}

export const REDACTED = "[REDACTED]";
const BASE64_ONLY = /^[A-Za-z0-9+/=]{40,}$/;

/**
 * Redact secret-looking text (rules a-d). Runs before any length cap so a
 * cut can never leave half a secret.
 */
export function redactSecrets(text: string): string {
  let out = text;
  // (d) whole content of a single-line string literal that is pure 40+ base64 chars.
  out = out.replace(/'([^'\n]*)'|"([^"\n]*)"|`([^`\n]*)`/g, (match) => {
    const quote = match.charAt(0);
    const content = match.slice(1, -1);
    if (BASE64_ONLY.test(content)) return `${quote}${REDACTED}${quote}`;
    return match;
  });
  // (a) (b) (c) anywhere in the text.
  out = out.replace(/AKIA[0-9A-Z]{16}/g, REDACTED);
  out = out.replace(/ghp_[A-Za-z0-9]{20,}/g, REDACTED);
  out = out.replace(/sk-[A-Za-z0-9]{20,}/g, REDACTED);
  return out;
}

function collapseSignature(text: string): string {
  let single = text.replace(/\s+/g, " ").trim();
  if (single.length > 300) {
    single = single.slice(0, 297) + "...";
  }
  return single;
}

function signatureFor(
  ts: typeof bundledTs,
  checker: bundledTs.TypeChecker,
  raw: RawSymbol,
  absRoot: string,
): string {
  let source: string | null = null;
  try {
    if (raw.kind === "class") {
      source = `class ${raw.name}`;
    } else if (raw.kind === "interface") {
      source = `interface ${raw.name}`;
    } else if (raw.kind === "type") {
      const decl = raw.declaration as bundledTs.TypeAliasDeclaration;
      source = `type ${raw.name} = ${decl.type.getText()}`;
    } else if (raw.kind === "const") {
      const decl = raw.declaration as bundledTs.VariableDeclaration;
      const t = checker.getTypeAtLocation(decl.name);
      const typeString = checker.typeToString(
        t,
        undefined,
        ts.TypeFormatFlags.NoTruncation,
      );
      source = `const ${raw.name}: ${typeString}`;
    } else {
      // function or method: "<name><checker signature>".
      let target: bundledTs.Node = raw.declaration;
      if (
        raw.kind === "function" &&
        ts.isVariableDeclaration(raw.declaration) &&
        raw.declaration.initializer
      ) {
        const unwrapped = unwrapParens(ts, raw.declaration.initializer);
        if (
          ts.isArrowFunction(unwrapped) ||
          ts.isFunctionExpression(unwrapped)
        ) {
          target = unwrapped;
        }
      }
      const sig = checker.getSignatureFromDeclaration(
        target as bundledTs.SignatureDeclaration,
      );
      if (sig) {
        const rendered = checker.signatureToString(
          sig,
          undefined,
          ts.TypeFormatFlags.NoTruncation,
        );
        source = `${raw.name}${rendered}`;
      }
    }
  } catch {
    source = null;
  }
  if (source === null) {
    // Never throw: some signatures cannot be computed by the checker.
    return "(unknown signature)";
  }
  // Order: scrubPaths -> redactSecrets -> collapseSignature (300-char cut last).
  return collapseSignature(redactSecrets(scrubPaths(source, absRoot)));
}

export interface IndexedSymbol extends RawSymbol {
  symbol_id: string;
  signature: string;
}

export interface SymbolIndex {
  project: ProjectIndex;
  symbols: readonly IndexedSymbol[];
  getById(id: string): IndexedSymbol | undefined;
  all(): readonly IndexedSymbol[];
  findEnclosing(file: string, offset: number): IndexedSymbol | undefined;
}

export function toSummary(sym: IndexedSymbol): SymbolSummary {
  return {
    symbol_id: sym.symbol_id,
    name: sym.name,
    kind: sym.kind,
    file: sym.file,
    line: sym.line,
    exported: sym.exported,
    is_test: sym.is_test,
    signature: sym.signature,
    doc_summary: sym.doc_summary,
  };
}

export function buildIndex(project: ProjectIndex): SymbolIndex {
  const ts = project.ts;
  const checker = project.program.getTypeChecker();
  const raws = extractSymbols(project);
  const byId = new Map<string, IndexedSymbol>();
  const symbols: IndexedSymbol[] = raws.map((raw, i) => {
    const sym: IndexedSymbol = {
      ...raw,
      symbol_id: `s_${i + 1}`,
      signature: signatureFor(ts, checker, raw, project.root),
    };
    byId.set(sym.symbol_id, sym);
    return sym;
  });
  const validId = (id: string): boolean => {
    const m = /^s_([1-9][0-9]*)$/.exec(id);
    if (!m) return false;
    const n = Number(m[1]);
    return n >= 1 && n <= symbols.length;
  };
  return {
    project,
    symbols,
    getById(id: string): IndexedSymbol | undefined {
      if (!validId(id)) return undefined;
      return byId.get(id);
    },
    all(): readonly IndexedSymbol[] {
      return symbols;
    },
    findEnclosing(file: string, offset: number): IndexedSymbol | undefined {
      let best: IndexedSymbol | undefined;
      for (const sym of symbols) {
        if (sym.file !== file) continue;
        if (offset < sym.startOffset || offset >= sym.endOffset) continue;
        if (
          !best ||
          sym.startOffset > best.startOffset ||
          (sym.startOffset === best.startOffset &&
            sym.endOffset < best.endOffset)
        ) {
          best = sym;
        }
      }
      return best;
    },
  };
}
