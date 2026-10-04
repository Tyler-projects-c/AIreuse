import type { IndexedSymbol, SymbolIndex } from "./index.js";
import path from "node:path";
import { redactSecrets, toForwardSlashes, toSummary } from "./index.js";
import {
  GetDefinitionInputSchema,
  GetDefinitionOutputSchema,
  SearchSymbolsInputSchema,
  SearchSymbolsOutputSchema,
  err,
  ok,
} from "./schemas.js";
import type {
  GetDefinitionOutput,
  MatchSource,
  ResultEnvelope,
  SymbolSummary,
} from "./schemas.js";

const MAX_RESULT_BYTES = 6144;

/**
 * Shared INVALID_ARGS envelope built from a failed input schema parse.
 * Message is "<first issue path>: <message>", capped at 200 chars.
 */
function invalidArgs(inputError: {
  issues: readonly { path: (string | number)[]; message: string }[];
}): ResultEnvelope {
  const issue = inputError.issues[0];
  const where = issue && issue.path.length > 0 ? issue.path.join(".") : "input";
  const message = `${where}: ${issue ? issue.message : "invalid input"}`;
  return err("INVALID_ARGS", message.slice(0, 200));
}

/** Split on non-alphanumerics and camelCase boundaries; lowercase; drop empties. */
function tokenize(text: string): Set<string> {
  const spaced = text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  const tokens = new Set<string>();
  for (const part of spaced.split(/[^A-Za-z0-9]+/)) {
    const lower = part.toLowerCase();
    if (lower.length > 0) tokens.add(lower);
  }
  return tokens;
}

interface Prepared {
  sym: IndexedSymbol;
  summary: SymbolSummary;
  nameTokens: Set<string>;
  docTokens: Set<string>;
  signatureTokens: Set<string>;
  lowerName: string;
  afterDot: string;
}

interface Scored {
  sym: IndexedSymbol;
  summary: SymbolSummary;
  score: number;
  match: MatchSource;
}

/**
 * Returns the normalized prefix, or null when the value is not a valid
 * repo-relative prefix (absolute, drive-lettered, or containing "..").
 */
function normalizePathPrefix(raw: string): string | null {
  const normalized = toForwardSlashes(raw).trim();
  if (/^[A-Za-z]:/.test(normalized)) return null;
  if (normalized.startsWith("/")) return null;
  const stripped = normalized.replace(/^\.\//, "");
  if (stripped.split("/").includes("..")) return null;
  return stripped;
}

/** Walk up from an import declaration part to the enclosing ImportDeclaration. */
function moduleSpecifierOf(
  ts: typeof import("typescript"),
  node: import("typescript").Node | undefined,
): import("typescript").Expression | undefined {
  let current = node;
  while (current) {
    if (ts.isImportDeclaration(current)) return current.moduleSpecifier;
    current = current.parent;
  }
  return undefined;
}

function localBindingName(
  ts: typeof import("typescript"),
  decl: import("typescript").Node,
): string | undefined {
  if (ts.isImportClause(decl)) return decl.name?.text;
  if (ts.isNamespaceImport(decl)) return decl.name.text;
  if (ts.isImportSpecifier(decl)) return decl.name.text;
  return undefined;
}

/**
 * Imports used by a symbol, via the type checker (never text matching).
 * Modules sorted ascending; names unique and sorted ascending.
 */
function collectImportsUsed(
  ts: typeof import("typescript"),
  checker: import("typescript").TypeChecker,
  rangeNode: import("typescript").Node,
): { module: string; names: string[] }[] {
  const byModule = new Map<string, Set<string>>();

  const recordSymbol = (
    symbol: import("typescript").Symbol | undefined,
  ): void => {
    if (!symbol) return;
    for (const decl of symbol.declarations ?? []) {
      if (
        !ts.isImportSpecifier(decl) &&
        !ts.isImportClause(decl) &&
        !ts.isNamespaceImport(decl)
      ) {
        continue;
      }
      const specifier = moduleSpecifierOf(ts, decl);
      // Only string literal specifiers are recorded; others are skipped.
      if (!specifier || !ts.isStringLiteral(specifier)) continue;
      const local = localBindingName(ts, decl);
      if (local === undefined) continue;
      let names = byModule.get(specifier.text);
      if (!names) {
        names = new Set<string>();
        byModule.set(specifier.text, names);
      }
      names.add(local);
    }
  };

  const record = (id: import("typescript").Node): void => {
    recordSymbol(checker.getSymbolAtLocation(id));
  };

  const visit = (node: import("typescript").Node): void => {
    // Property names (obj.helper) and qualified-name right sides are not bindings.
    if (ts.isPropertyAccessExpression(node)) {
      visit(node.expression);
      return;
    }
    if (ts.isQualifiedName(node)) {
      visit(node.left);
      return;
    }
    // Shorthand `{ helper }` binds the import value; `{ helper: 1 }` does not.
    if (ts.isShorthandPropertyAssignment(node)) {
      recordSymbol(checker.getShorthandAssignmentValueSymbol(node));
      return;
    }
    if (ts.isIdentifier(node)) {
      record(node);
      return;
    }
    ts.forEachChild(node, visit);
  };

  visit(rangeNode);

  return [...byModule.entries()]
    .map(([module, names]) => ({ module, names: [...names].sort() }))
    .sort((a, b) => (a.module < b.module ? -1 : a.module > b.module ? 1 : 0));
}

/** True when the symbol's JSDoc carries a @deprecated tag. */
function isDeprecated(
  ts: typeof import("typescript"),
  checker: import("typescript").TypeChecker,
  sym: IndexedSymbol,
): boolean {
  try {
    const decl = sym.declaration as { name?: import("typescript").Node };
    if (decl.name) {
      const symbol = checker.getSymbolAtLocation(decl.name);
      if (symbol) {
        const tags = symbol.getJsDocTags(checker);
        if (tags.some((t) => t.name.toLowerCase() === "deprecated")) return true;
      }
    }
  } catch {
    // Fall back to the jsDoc property below.
  }
  for (const node of [sym.declaration, sym.rangeNode]) {
    const jsDocs = (node as { jsDoc?: unknown }).jsDoc;
    if (!Array.isArray(jsDocs)) continue;
    for (const doc of jsDocs) {
      const tags = (doc as { tags?: unknown }).tags;
      if (!Array.isArray(tags)) continue;
      for (const tag of tags) {
        const tagName = (tag as { tagName?: { text?: string } }).tagName;
        if (
          tagName &&
          typeof tagName.text === "string" &&
          tagName.text.toLowerCase() === "deprecated"
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

export function createTools(index: SymbolIndex): {
  search_symbols(input: unknown): ResultEnvelope;
  get_definition(input: unknown): ResultEnvelope;
  get_references(input: unknown): ResultEnvelope;
  get_signature(input: unknown): ResultEnvelope;
} {
  // Token sets are computed once per symbol, not on every call.
  const prepared: Prepared[] = index.all().map((sym) => {
    const afterDot = sym.name.includes(".")
      ? sym.name.slice(sym.name.lastIndexOf(".") + 1)
      : sym.name;
    return {
      sym,
      summary: toSummary(sym),
      nameTokens: tokenize(sym.name),
      docTokens: sym.doc_summary ? tokenize(sym.doc_summary) : new Set<string>(),
      signatureTokens: tokenize(sym.signature),
      lowerName: sym.name.toLowerCase(),
      afterDot: afterDot.toLowerCase(),
    };
  });

  function search_symbols(input: unknown): ResultEnvelope {
    const parsed = SearchSymbolsInputSchema.safeParse(input);
    if (!parsed.success) return invalidArgs(parsed.error);
    const args = parsed.data;
    let prefix: string | null = null;
    if (args.path_prefix !== undefined) {
      const normalized = normalizePathPrefix(args.path_prefix);
      if (normalized === null) {
        return err("INVALID_ARGS", "path_prefix must be repo-relative");
      }
      prefix = normalized;
    }

    const queryTrimmed = args.query.trim().toLowerCase();
    const queryTokens = [...tokenize(args.query)];
    const scored: Scored[] = [];
    for (const p of prepared) {
      if (!args.include_tests && p.sym.is_test) continue;
      if (args.kind !== undefined && p.sym.kind !== args.kind) continue;
      if (prefix !== null && !p.sym.file.startsWith(prefix)) continue;
      const fullNameBonus =
        p.lowerName === queryTrimmed || p.afterDot === queryTrimmed ? 5 : 0;
      let nameScore = fullNameBonus;
      let docScore = 0;
      let signatureScore = 0;
      for (const token of queryTokens) {
        if (p.nameTokens.has(token)) nameScore += 3;
        if (p.docTokens.has(token)) docScore += 1.5;
        if (p.signatureTokens.has(token)) signatureScore += 1;
      }
      const score = nameScore + docScore + signatureScore;
      if (score === 0) continue;
      let match: MatchSource;
      if (nameScore >= docScore && nameScore >= signatureScore) {
        match = "name";
      } else if (docScore >= signatureScore) {
        match = "doc";
      } else {
        match = "signature";
      }
      scored.push({ sym: p.sym, summary: p.summary, score, match });
    }

    scored.sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      if (a.sym.file !== b.sym.file) return a.sym.file < b.sym.file ? -1 : 1;
      return a.sym.line - b.sym.line;
    });

    let truncated = scored.length > args.limit;
    let results: (SymbolSummary & { match: MatchSource })[] = scored
      .slice(0, args.limit)
      .map((s) => ({ ...s.summary, match: s.match }));
    // Trim from the end until the serialized envelope fits the 6 KB cap.
    while (
      results.length > 0 &&
      Buffer.byteLength(
        JSON.stringify(ok({ results, truncated })),
        "utf8",
      ) > MAX_RESULT_BYTES
    ) {
      results = results.slice(0, -1);
      truncated = true;
    }
    // parse() throws only for programmer errors; bad input is handled above.
    const data = SearchSymbolsOutputSchema.parse({ results, truncated });
    return ok(data);
  }

  function get_definition(input: unknown): ResultEnvelope {
    const parsed = GetDefinitionInputSchema.safeParse(input);
    if (!parsed.success) return invalidArgs(parsed.error);
    const args = parsed.data;
    const sym = index.getById(args.symbol_id);
    if (!sym) {
      return err("UNKNOWN_SYMBOL", `unknown symbol_id: ${args.symbol_id}`);
    }
    const project = index.project;
    const ts = project.ts;
    const checker = project.program.getTypeChecker();

    let sourceFile: import("typescript").SourceFile | undefined;
    try {
      sourceFile = sym.rangeNode.getSourceFile();
    } catch {
      sourceFile = undefined;
    }
    if (!sourceFile || !ts.isSourceFile(sourceFile)) {
      sourceFile = project.program.getSourceFile(
        path.join(project.root, sym.file),
      );
    }
    if (!sourceFile) {
      return err("UNKNOWN_SYMBOL", `source file not found: ${sym.file}`);
    }

    let startPos = sym.rangeNode.getStart(sourceFile, false);
    const endPos = sym.rangeNode.getEnd();
    // Include the declaration's own leading indentation, but never a
    // preceding newline or JSDoc/comment (getStart already skipped those).
    while (
      startPos > 0 &&
      sourceFile.text[startPos - 1] !== "\n" &&
      sourceFile.text[startPos - 1] !== "\r" &&
      /\s/.test(sourceFile.text[startPos - 1] as string)
    ) {
      startPos--;
    }
    const normalized = sourceFile.text
      .slice(startPos, endPos)
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n");
    const fullLines = normalized.split("\n");
    const lineCount = fullLines.length;
    const startLine = sourceFile.getLineAndCharacterOfPosition(startPos).line + 1;
    const endLine =
      sourceFile.getLineAndCharacterOfPosition(
        Math.max(startPos, endPos - 1),
      ).line + 1;

    const summary = toSummary(sym);
    const deprecated = isDeprecated(ts, checker, sym);
    // Imports are computed over the whole symbol, not just the shown lines.
    const importsUsed = collectImportsUsed(ts, checker, sym.rangeNode);

    let truncated = fullLines.length > args.max_lines;
    let bodyLines = redactSecrets(
      fullLines.slice(0, args.max_lines).join("\n"),
    ).split("\n");
    let body = bodyLines.join("\n");

    const makeData = (text: string): GetDefinitionOutput => ({
      symbol: summary,
      range: { start_line: startLine, end_line: endLine },
      body: text,
      body_truncated: truncated,
      line_count: lineCount,
      imports_used: importsUsed,
      in_current_diff: false,
      deprecated,
    });
    const fits = (text: string): boolean =>
      Buffer.byteLength(JSON.stringify(ok(makeData(text))), "utf8") <=
      MAX_RESULT_BYTES;

    while (!fits(body)) {
      if (bodyLines.length > 1) {
        bodyLines.pop();
        truncated = true;
        body = bodyLines.join("\n");
        continue;
      }
      const line = bodyLines[0] ?? "";
      if (line.length === 0) break;
      let lo = 0;
      let hi = line.length;
      while (lo < hi) {
        const mid = Math.floor((lo + hi + 1) / 2);
        if (fits(line.slice(0, mid))) lo = mid;
        else hi = mid - 1;
      }
      if (lo >= line.length) break;
      bodyLines[0] = line.slice(0, lo);
      body = bodyLines[0];
      truncated = true;
    }

    // parse() throws only for programmer errors; bad input is handled above.
    return ok(GetDefinitionOutputSchema.parse(makeData(body)));
  }

  // The remaining tools are not implemented yet; they must never throw.
  const notImplemented = (): ResultEnvelope =>
    err("INVALID_ARGS", "not implemented");

  return {
    search_symbols,
    get_definition,
    get_references: notImplemented,
    get_signature: notImplemented,
  };
}
