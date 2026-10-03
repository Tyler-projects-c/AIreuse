import type { IndexedSymbol, SymbolIndex } from "./index.js";
import { toForwardSlashes, toSummary } from "./index.js";
import {
  SearchSymbolsInputSchema,
  SearchSymbolsOutputSchema,
  err,
  ok,
} from "./schemas.js";
import type {
  MatchSource,
  ResultEnvelope,
  SymbolSummary,
} from "./schemas.js";

const MAX_RESULT_BYTES = 6144;

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
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where =
        issue && issue.path.length > 0 ? issue.path.join(".") : "input";
      const message = `${where}: ${issue ? issue.message : "invalid input"}`;
      return err("INVALID_ARGS", message.slice(0, 200));
    }
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

  // The remaining tools are not implemented yet; they must never throw.
  const notImplemented = (): ResultEnvelope =>
    err("INVALID_ARGS", "not implemented");

  return {
    search_symbols,
    get_definition: notImplemented,
    get_references: notImplemented,
    get_signature: notImplemented,
  };
}
