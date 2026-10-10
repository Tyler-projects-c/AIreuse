import type { IndexedSymbol, SymbolIndex } from "./index.js";
import path from "node:path";
import {
  getCallable,
  isTestPath,
  redactSecrets,
  scrubPaths,
  toForwardSlashes,
  toRepoRelative,
  toSummary,
} from "./index.js";
import {
  GetDefinitionInputSchema,
  GetDefinitionOutputSchema,
  GetReferencesInputSchema,
  GetReferencesOutputSchema,
  GetSignatureInputSchema,
  GetSignatureOutputSchema,
  SearchSymbolsInputSchema,
  SearchSymbolsOutputSchema,
  err,
  ok,
} from "./schemas.js";
import { stemAll, stemToken, tokenize } from "./text.js";
import type {
  GetDefinitionOutput,
  GetReferencesOutput,
  GetSignatureOutput,
  MatchSource,
  ReferenceKind,
  ResultEnvelope,
  SignatureCompat,
  SymbolSummary,
} from "./schemas.js";

const MAX_RESULT_BYTES = 6144;
const MAX_BY_FILE = 20;

// Token weights (SPEC Task 10). A token that matches EXACTLY always scores
// strictly more than one that only matches through its stem, so existing
// exact-token ranking is preserved and stem hits slot in below it.
const WEIGHT_NAME_TOKEN = 3;
const WEIGHT_NAME_STEM = 2;
const WEIGHT_DOC_TOKEN = 1.5;
const WEIGHT_DOC_STEM = 1.2;
const WEIGHT_SIG_TOKEN = 1;
const WEIGHT_SIG_STEM = 0.6;

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

interface Prepared {
  sym: IndexedSymbol;
  summary: SymbolSummary;
  nameTokens: Set<string>;
  docTokens: Set<string>;
  signatureTokens: Set<string>;
  nameStems: Set<string>;
  docStems: Set<string>;
  signatureStems: Set<string>;
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

/** Deepest node whose text spans `position` (mirrors getTokenAtPosition). */
function deepestNodeAt(
  root: import("typescript").Node,
  position: number,
): import("typescript").Node {
  let current = root;
  for (;;) {
    let next: import("typescript").Node | undefined;
    current.forEachChild((child) => {
      if (
        next === undefined &&
        child.getFullStart() <= position &&
        child.getEnd() > position
      ) {
        next = child;
      }
      return undefined;
    });
    if (!next) return current;
    current = next;
  }
}

/** True when `node` sits inside an import/export specifier or declaration. */
function isImportLikeNode(
  ts: typeof import("typescript"),
  node: import("typescript").Node,
): boolean {
  for (let n: import("typescript").Node | undefined = node; n; n = n.parent) {
    if (
      ts.isImportSpecifier(n) ||
      ts.isImportClause(n) ||
      ts.isNamespaceImport(n) ||
      ts.isExportSpecifier(n) ||
      ts.isImportDeclaration(n) ||
      ts.isExportDeclaration(n)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * True when `node` is exactly the direct callee of a call or new expression.
 * From the reference we climb only through a PropertyAccessExpression whose
 * `.name` is the current node (so `ns.ping(1)` counts), or a
 * ParenthesizedExpression / NonNullExpression; anything else stops the walk,
 * so call arguments and call results never count.
 */
function isCallTargetNode(
  ts: typeof import("typescript"),
  node: import("typescript").Node,
): boolean {
  let current: import("typescript").Node = node;
  for (;;) {
    const parent: import("typescript").Node | undefined = current.parent;
    if (parent === undefined) return false;
    if (ts.isPropertyAccessExpression(parent) && parent.name === current) {
      current = parent;
      continue;
    }
    if (
      ts.isParenthesizedExpression(parent) ||
      ts.isNonNullExpression(parent)
    ) {
      current = parent;
      continue;
    }
    return (
      (ts.isCallExpression(parent) || ts.isNewExpression(parent)) &&
      parent.expression === current
    );
  }
}

/** True when any ancestor of `node` is a type node. */
function isTypePositionNode(
  ts: typeof import("typescript"),
  node: import("typescript").Node,
): boolean {
  for (
    let n: import("typescript").Node | undefined = node.parent;
    n;
    n = n.parent
  ) {
    if (ts.isTypeNode(n)) return true;
  }
  return false;
}

/** SPEC order: import, then call, then type_use, else other. */
function classifyReference(
  ts: typeof import("typescript"),
  node: import("typescript").Node,
): ReferenceKind {
  if (isImportLikeNode(ts, node)) return "import";
  if (isCallTargetNode(ts, node)) return "call";
  if (isTypePositionNode(ts, node)) return "type_use";
  return "other";
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

function collapseWs(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * scrubPaths -> redactSecrets -> collapse, then cut to 300 chars. The cut
 * always happens after redaction so it can never split a secret in half.
 */
function sanitizeTypeText(text: string, absRoot: string): string {
  const cleaned = collapseWs(redactSecrets(scrubPaths(text, absRoot)));
  return cleaned.length > 300 ? cleaned.slice(0, 300) : cleaned;
}

type Callable = NonNullable<ReturnType<typeof getCallable>>;

interface ParamInfo {
  name: string;
  type: string;
  optional: boolean;
  required: boolean;
  raw: import("typescript").Type | undefined;
}

interface CallableInfo {
  params: ParamInfo[];
  returnType: import("typescript").Type | undefined;
  returnText: string;
  typeParams: string[];
  typeSignature: string;
  isAsync: boolean;
  hasTypeParams: boolean;
  hasRest: boolean;
}

/** Everything get_signature needs to know about one callable symbol. */
function describeCallable(
  ts: typeof import("typescript"),
  checker: import("typescript").TypeChecker,
  callable: Callable,
  sym: IndexedSymbol,
  absRoot: string,
): CallableInfo {
  const params: ParamInfo[] = [];
  let hasRest = false;
  for (const p of callable.signature.parameters) {
    const vd = p.valueDeclaration;
    if (!vd || !ts.isParameter(vd)) continue;
    // `this` names the receiver; it is not one of the symbol's parameters.
    const nameNode = vd.name as import("typescript").Node;
    if (nameNode.kind === ts.SyntaxKind.ThisKeyword) continue;
    if (vd.dotDotDotToken !== undefined) hasRest = true;
    let raw: import("typescript").Type | undefined;
    try {
      raw = checker.getTypeOfSymbolAtLocation(p, vd);
    } catch {
      raw = undefined;
    }
    params.push({
      // Source text, so a destructured param reads "{ a, b }". Redaction runs
      // BEFORE the 60-char cut so a cut can never leave half a secret.
      name: collapseWs(redactSecrets(vd.name.getText())).slice(0, 60),
      type:
        raw === undefined
          ? ""
          : sanitizeTypeText(
              checker.typeToString(
                raw,
                undefined,
                ts.TypeFormatFlags.NoTruncation,
              ),
              absRoot,
            ),
      optional:
        vd.questionToken !== undefined ||
        vd.initializer !== undefined ||
        vd.dotDotDotToken !== undefined,
      required:
        vd.questionToken === undefined &&
        vd.initializer === undefined &&
        vd.dotDotDotToken === undefined,
      raw,
    });
  }

  let returnType: import("typescript").Type | undefined;
  let returnText = "";
  try {
    returnType = callable.signature.getReturnType();
    returnText = sanitizeTypeText(
      checker.typeToString(
        returnType,
        undefined,
        ts.TypeFormatFlags.NoTruncation,
      ),
      absRoot,
    );
  } catch {
    returnType = undefined;
    returnText = "";
  }

  const decl = callable.declaration as {
    typeParameters?: import("typescript").NodeArray<
      import("typescript").TypeParameterDeclaration
    >;
    modifiers?: readonly { kind: import("typescript").SyntaxKind }[];
  };
  const typeParams = (decl.typeParameters ?? []).map((tp) =>
    collapseWs(redactSecrets(tp.getText())).slice(0, 100),
  );
  const hasTypeParams =
    typeParams.length > 0 ||
    (callable.signature.typeParameters?.length ?? 0) > 0;
  const isAsync =
    decl.modifiers !== undefined &&
    decl.modifiers.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);

  let typeSignature = "";
  try {
    const rendered = checker.signatureToString(
      callable.signature,
      undefined,
      ts.TypeFormatFlags.NoTruncation,
    );
    typeSignature = collapseWs(
      redactSecrets(scrubPaths(`${sym.name}${rendered}`, absRoot)),
    );
  } catch {
    typeSignature = "";
  }

  return {
    params,
    returnType,
    returnText,
    typeParams,
    typeSignature,
    isAsync,
    hasTypeParams,
    hasRest,
  };
}

/** Could callers of A be switched to B? "unknown" when undecidable. */
function compatFor(
  ts: typeof import("typescript"),
  checker: import("typescript").TypeChecker,
  a: CallableInfo,
  b: CallableInfo,
): SignatureCompat {
  const sameParamCount = a.params.length === b.params.length;
  const undecidable =
    a.hasTypeParams ||
    b.hasTypeParams ||
    a.hasRest ||
    b.hasRest ||
    typeof checker.isTypeAssignableTo !== "function" ||
    a.returnType === undefined ||
    b.returnType === undefined ||
    a.params.some((p) => p.raw === undefined) ||
    b.params.some((p) => p.raw === undefined);

  let paramsAssignable: boolean | "unknown";
  let returnAssignable: boolean | "unknown";
  if (undecidable) {
    paramsAssignable = "unknown";
    returnAssignable = "unknown";
  } else {
    const required = (info: CallableInfo): number =>
      info.params.filter((p) => p.required).length;
    if (required(b) > required(a)) {
      // B demands arguments A's callers never pass.
      paramsAssignable = false;
    } else if (a.params.length > b.params.length) {
      // A has a parameter at a position where B has none at all.
      paramsAssignable = false;
    } else {
      paramsAssignable = a.params.every((p, i) => {
        const target = b.params[i];
        return (
          target !== undefined &&
          p.raw !== undefined &&
          target.raw !== undefined &&
          checker.isTypeAssignableTo(p.raw, target.raw)
        );
      });
    }
    returnAssignable = checker.isTypeAssignableTo(
      b.returnType as import("typescript").Type,
      a.returnType as import("typescript").Type,
    );
  }

  return {
    same_param_count: sameParamCount,
    params_assignable: paramsAssignable,
    return_assignable: returnAssignable,
    async_match: a.isAsync === b.isAsync,
  };
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
    const nameTokens = tokenize(sym.name);
    const docTokens = sym.doc_summary
      ? tokenize(sym.doc_summary)
      : new Set<string>();
    const signatureTokens = tokenize(sym.signature);
    return {
      sym,
      summary: toSummary(sym),
      nameTokens,
      docTokens,
      signatureTokens,
      nameStems: stemAll(nameTokens),
      docStems: stemAll(docTokens),
      signatureStems: stemAll(signatureTokens),
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
        const stem = stemToken(token);
        if (p.nameTokens.has(token)) nameScore += WEIGHT_NAME_TOKEN;
        else if (p.nameStems.has(stem)) nameScore += WEIGHT_NAME_STEM;
        if (p.docTokens.has(token)) docScore += WEIGHT_DOC_TOKEN;
        else if (p.docStems.has(stem)) docScore += WEIGHT_DOC_STEM;
        if (p.signatureTokens.has(token)) signatureScore += WEIGHT_SIG_TOKEN;
        else if (p.signatureStems.has(stem)) signatureScore += WEIGHT_SIG_STEM;
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

  function get_signature(input: unknown): ResultEnvelope {
    const parsed = GetSignatureInputSchema.safeParse(input);
    if (!parsed.success) return invalidArgs(parsed.error);
    const args = parsed.data;

    const project = index.project;
    const ts = project.ts;
    const checker = project.program.getTypeChecker();

    const sym = index.getById(args.symbol_id);
    if (!sym) {
      return err("UNKNOWN_SYMBOL", `unknown symbol_id: ${args.symbol_id}`);
    }
    const callable = getCallable(project, sym);
    if (!callable) {
      return err("INVALID_ARGS", "symbol has no call signature");
    }

    let other: Callable | undefined;
    let otherSym: IndexedSymbol | undefined;
    if (args.compare_to !== undefined) {
      otherSym = index.getById(args.compare_to);
      if (!otherSym) {
        return err("UNKNOWN_SYMBOL", `unknown symbol_id: ${args.compare_to}`);
      }
      other = getCallable(project, otherSym);
      if (!other) {
        return err("INVALID_ARGS", "symbol has no call signature");
      }
    }

    const a = describeCallable(ts, checker, callable, sym, project.root);
    const compat =
      other !== undefined && otherSym !== undefined
        ? compatFor(
            ts,
            checker,
            a,
            describeCallable(ts, checker, other, otherSym, project.root),
          )
        : undefined;

    const data: GetSignatureOutput = {
      name: sym.name,
      type_signature: a.typeSignature,
      params: a.params.map((p) => ({
        name: p.name,
        type: p.type,
        optional: p.optional,
      })),
      return_type: a.returnText,
      type_params: a.typeParams,
      is_async: a.isAsync,
      exported: sym.exported,
      ...(compat ? { compat } : {}),
    };

    // parse() throws only for programmer errors; bad input is handled above.
    const valid = GetSignatureOutputSchema.parse(data);
    if (Buffer.byteLength(JSON.stringify(ok(valid)), "utf8") > MAX_RESULT_BYTES) {
      // Never silently drop parameters: report the budget instead.
      return err("BUDGET_EXCEEDED", "signature too large");
    }
    return ok(valid);
  }

  function get_references(input: unknown): ResultEnvelope {
    const parsed = GetReferencesInputSchema.safeParse(input);
    if (!parsed.success) return invalidArgs(parsed.error);
    const args = parsed.data;

    const sym = index.getById(args.symbol_id);
    if (!sym) {
      return err("UNKNOWN_SYMBOL", `unknown symbol_id: ${args.symbol_id}`);
    }
    const project = index.project;
    const ts = project.ts;

    let declFile: import("typescript").SourceFile | undefined;
    try {
      declFile = sym.rangeNode.getSourceFile();
    } catch {
      declFile = undefined;
    }
    if (!declFile) {
      declFile = project.program.getSourceFile(
        path.join(project.root, sym.file),
      );
    }
    if (!declFile) {
      return err("UNKNOWN_SYMBOL", `source file not found: ${sym.file}`);
    }

    let groups: readonly import("typescript").ReferencedSymbol[] = [];
    try {
      groups =
        project.service.findReferences(declFile.fileName, sym.nameOffset) ??
        [];
    } catch {
      groups = [];
    }

    const kindFilter =
      args.kinds !== undefined ? new Set<string>(args.kinds) : null;

    interface Found {
      file: string;
      line: number;
      offset: number;
      kind: ReferenceKind;
      enclosingId: string | null;
      context: string;
    }

    const seen = new Set<string>();
    const found: Found[] = [];
    for (const group of groups) {
      for (const entry of group.references) {
        // The symbol's own declaration is never a reference. Import
        // specifiers arrive as separate alias groups and stay, since they
        // are real "import" references.
        if (
          entry.isDefinition === true ||
          (entry.fileName === declFile.fileName &&
            entry.textSpan.start === sym.nameOffset)
        ) {
          continue;
        }
        const key =
          `${entry.fileName}:${entry.textSpan.start}:${entry.textSpan.length}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const relFile = toForwardSlashes(
          toRepoRelative(project.root, entry.fileName),
        );
        // A reference outside the repo root (e.g. a linked lib) is skipped.
        if (relFile.startsWith("..") || path.isAbsolute(relFile)) continue;
        if (!args.include_tests && isTestPath(relFile)) continue;

        const sourceFile = project.program.getSourceFile(entry.fileName);
        if (!sourceFile) continue;

        const node = deepestNodeAt(sourceFile, entry.textSpan.start);
        const kind = classifyReference(ts, node);
        if (kindFilter !== null && !kindFilter.has(kind)) continue;

        const lc = sourceFile.getLineAndCharacterOfPosition(
          entry.textSpan.start,
        );
        const starts = sourceFile.getLineStarts();
        const lineStart = starts[lc.line] ?? 0;
        const lineEnd =
          lc.line + 1 < starts.length
            ? (starts[lc.line + 1] as number)
            : sourceFile.text.length;
        const trimmed = sourceFile.text.slice(lineStart, lineEnd).trim();
        const safe = redactSecrets(scrubPaths(trimmed, project.root));
        const enclosing = index.findEnclosing(relFile, entry.textSpan.start);

        found.push({
          file: relFile,
          line: lc.line + 1,
          offset: entry.textSpan.start,
          kind,
          enclosingId: enclosing ? enclosing.symbol_id : null,
          context: safe.length > 200 ? safe.slice(0, 200) : safe,
        });
      }
    }

    found.sort((a, b) => {
      if (a.file !== b.file) return a.file < b.file ? -1 : 1;
      if (a.offset !== b.offset) return a.offset - b.offset;
      return a.line - b.line;
    });

    const total = found.length;
    const counts = new Map<string, number>();
    for (const f of found) counts.set(f.file, (counts.get(f.file) ?? 0) + 1);
    const allByFile = [...counts.entries()]
      .sort((a, b) =>
        b[1] !== a[1] ? b[1] - a[1] : a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
      )
      .map(([file, count]) => ({ file, count }));
    const by_file = allByFile.slice(0, MAX_BY_FILE);
    const by_file_truncated = allByFile.length > by_file.length;

    let references = found.slice(0, args.limit).map((f) => ({
      file: f.file,
      line: f.line,
      kind: f.kind,
      enclosing_symbol_id: f.enclosingId,
      context: f.context,
    }));
    let truncated = found.length > references.length;

    const build = (): GetReferencesOutput =>
      GetReferencesOutputSchema.parse({
        total,
        by_file,
        by_file_truncated,
        references,
        truncated,
      });

    // Trim whole references from the end until the 6 KB cap is met.
    while (
      references.length > 0 &&
      Buffer.byteLength(JSON.stringify(ok(build())), "utf8") > MAX_RESULT_BYTES
    ) {
      references = references.slice(0, -1);
      truncated = true;
    }

    return ok(build());
  }

  return {
    search_symbols,
    get_definition,
    get_references,
    get_signature,
  };
}
