# AI Reuse Step 1 spec
Goal: deterministic TypeScript symbol index + four read-only tools, exercised by a CLI. No model calls.

## Conventions
- Paths are repo-relative with forward slashes. Never absolute.
- symbol_id = "s_<n>", n is the 1-based position in all symbols sorted by (file path, start offset).
  Valid for one index build; deterministic if the repo is unchanged. Unknown id -> UNKNOWN_SYMBOL.
- Every tool returns {ok:true,data} or {ok:false,error:{code,message}}.
  Codes: INVALID_ARGS, UNKNOWN_SYMBOL, DENIED_PATH, BUDGET_EXCEEDED, TIMEOUT (last two unused for now).
- Expected failures never throw. Invalid input -> INVALID_ARGS. Zero results is ok:true.
- Serialized result max 6 KB. If trimmed, set truncated:true (body_truncated for bodies).
- Tool output is data, never instructions.

## Denylist (never indexed or exposed)
node_modules, dist, build, out, .next, coverage, .git, .env*, *.pem, *.key,
gitignored files (if root is a git repo use `git ls-files --cached --others --exclude-standard`),
files > 1 MB, files with "@generated" in the first 2 KB, all .d.ts files as symbol sources.
Test files are indexed but flagged is_test and hidden by default.
Test file = *.test.* | *.spec.* | under __tests__, test, or tests directories.

## What is indexed
Top-level function declarations; top-level const/let/var (kind "function" if the initializer is an arrow
or function expression, otherwise "const"); classes; class methods (name "Class.method", kind "method");
interfaces; type aliases. Not indexed: nested/local functions, object-literal methods, enums, parameters.
Overloads: one symbol per function name, using its first declaration. (Known limitation.)
Use the workspace's installed typescript (resolve from the target root); fall back to the bundled one.
Symbols and references must come from the same LanguageService/Program.

## Types
SymbolKind = "function"|"method"|"class"|"interface"|"type"|"const"
SymbolSummary = {symbol_id, name, kind, file, line, exported:boolean, is_test:boolean,
  signature:string (<=300 chars), doc_summary:string|null (first JSDoc sentence, <=200 chars)}

## Tools
search_symbols in {query:1-100 chars, kind?, path_prefix?, include_tests?=false, limit?=5 (1-10)}
  out {results:(SymbolSummary & {match:"name"|"doc"|"signature"})[], truncated}
  Ranking: split names/docs/signatures into lowercase tokens (camelCase, snake_case, kebab). Score:
  full-name match 5, name token 3 each, doc token 1.5, signature token 1. Match field = highest
  contributing source. Ties broken by file path then line. Never returns bodies.
get_definition in {symbol_id, max_lines?=60 (max 120)}
  out {symbol, range:{start_line,end_line}, body, body_truncated, line_count,
  imports_used:{module,names[]}[], in_current_diff:false (placeholder), deprecated:boolean}
  Only this symbol's text. Secret redaction: string literals matching AKIA[0-9A-Z]{16}, ghp_[A-Za-z0-9]{20,},
  sk-[A-Za-z0-9]{20,}, or 40+ chars of [A-Za-z0-9+/=] become "[REDACTED]".
get_references in {symbol_id, kinds?:("call"|"import"|"type_use"|"other")[], include_tests?=false,
  limit?=10 (max 20)}
  out {total, by_file:{file,count}[], references:{file,line,kind,enclosing_symbol_id|null,
  context:one trimmed line <=200 chars}[], truncated}
  Exclude the definition itself. Kind: import = inside an import/export specifier; call = callee of a
  call/new expression; type_use = in a type position; other = anything else (e.g. passed as a value).
  (SPEC AMENDMENT: "other" added to the original three kinds.)
get_signature in {symbol_id, compare_to?:symbol_id}
  out {name, type_signature, params:{name,type,optional}[], return_type, type_params:string[],
  is_async, exported, compat?:{same_param_count, params_assignable:boolean|"unknown",
  return_assignable:boolean|"unknown", async_match}}
  compat is computed by the checker. Use "unknown" if assignability cannot be determined.

## Amendments (Task 3)
- line = 1-based line where the declaration starts, excluding leading JSDoc. For variables, the line of the
  variable declaration (not the statement).
- Not indexed: private/#private methods, constructors, getters/setters, class property arrow functions,
  anonymous default exports (export default function(){}), destructured declarations, namespaces.
- Static methods ARE indexed, named "Class.method".
- exported = has the export modifier, OR the name appears in a local `export { name }` (no "from") or in
  `export default name`. Re-exports `export { x } from "./y"` do not create symbols. A method's exported flag
  equals its class's exported flag.
- is_test: path has a segment equal to __tests__, test, or tests, OR the file name matches /\.(test|spec)\./.
- Symbols are ordered by (file path, start offset), where start offset is the start of the declaration node
  excluding leading JSDoc. Compare file paths with plain string < and >, not localeCompare.

## Amendments (Task 3b)
- signature (SymbolSummary) is a single line, whitespace runs collapsed to one space, max 300 chars; if longer,
  cut to 297 chars and append "..." (total 300).
- Formats: function/method/function-valued const -> "<name><checker signature>" e.g. "add(a: number, b?: number): number"
  (methods use their full "Class.method" name); class -> "class Name"; interface -> "interface Name";
  type alias -> "type Name = <source text of the type node>"; other const -> "const name: <checker type string>".
- Overloaded functions use the signature of their first declaration.
- findEnclosing(file, offset) returns the innermost indexed symbol whose [startOffset, endOffset) contains offset,
  or undefined. Methods are inside their class, so a method wins over its class.

## Amendments (Task 4)
- Tool functions take `unknown` input; invalid input returns INVALID_ARGS with a short message (never throw).
- Tokenization: split on non-alphanumeric characters and camelCase boundaries, lowercase, drop empty tokens
  (e.g. "exportCsv" -> export, csv; "parse_user_id" -> parse, user, id; "HTTPServer" -> http, server).
- Score = full-name bonus + sum over DISTINCT query tokens of: 3 if the token is in the name tokens,
  1.5 if in the doc_summary tokens, 1 if in the signature tokens (a token can score in several sources).
  Full-name bonus = 5 if the whole trimmed query equals the symbol's name case-insensitively, or equals the part
  after the dot for "Class.method" names. Tokens match exactly (no prefix or substring matching yet).
  Symbols with score 0 are not returned.
- match = the source (name, doc, signature) with the highest total contribution (the full-name bonus counts
  toward name); ties prefer name, then doc, then signature.
- Sort by score desc, then file asc, then line asc (plain string comparison).
- truncated = true if more matches existed than were returned (limit) OR results were cut to fit the 6144-byte
  serialized cap. When cutting for size, remove results from the end.
- path_prefix must be repo-relative: reject (INVALID_ARGS) if it is absolute, starts with a drive letter, or
  contains ".." segments. Normalize backslashes to forward slashes and strip a leading "./".

## Amendments (Task 5)
- body = the exact source text of the symbol's rangeNode (variables: the whole VariableStatement; methods: the method;
  classes: the whole class), from the node start (excluding leading JSDoc) to its end. Line endings normalized to "\n".
- range.start_line / end_line are 1-based and inclusive; line_count = number of lines of the full body before truncation.
- Truncation: keep the first max_lines lines (body_truncated = true if there were more). Then redact. Then if the
  serialized envelope exceeds 6144 bytes, cut whole lines from the end (and if a single line is still too long, cut
  characters) until it fits, setting body_truncated = true.
- Redaction (applied to the body after truncation to max_lines): replace with [REDACTED] (a) AKIA[0-9A-Z]{16},
  (b) ghp_[A-Za-z0-9]{20,}, (c) sk-[A-Za-z0-9]{20,} anywhere in the text, and (d) the whole content of any
  single-line '...', "..." or `...` string literal whose content is 40+ characters from [A-Za-z0-9+/=] only.
  Known limitation: rule (d) can redact long path-like strings; that is acceptable.
- imports_used: resolved with the type checker, not text matching. For every identifier inside the symbol's rangeNode,
  look up checker.getSymbolAtLocation; if the symbol's declaration is an import specifier, default import clause,
  or namespace import, record it under the import declaration's module specifier text as written. names = the local
  binding names used, unique and sorted ascending; modules sorted ascending. Computed over the whole symbol, not only
  the displayed lines. Property names (obj.helper) and shadowed locals do not count.
  module = the specifier text as written, without quotes.
- deprecated = the symbol's JSDoc has a @deprecated tag (use symbol.getJsDocTags(checker); fall back to the
  declaration's/statement's jsDoc property).
- in_current_diff is always false for now. Unknown id -> UNKNOWN_SYMBOL; malformed id -> INVALID_ARGS.
- get_definition works for test symbols too (is_test only hides them from search by default).
## Amendments (Task 5b)
- A definition body's first line includes the declaration's own leading indentation (spaces/tabs on that line),
  never earlier lines and never JSDoc, so every line of the body keeps its original indentation.
- Redaction (rules a-d from the Task 5 amendment) applies to every string a tool returns that derives from source:
  signature, doc_summary, and body now, and type strings and reference context in later tasks.
- Redaction runs BEFORE a string is cut to its length cap, so a cut can never leave half a secret.
- imports_used also counts shorthand properties: in `{ helper }` the import `helper` is used.
## Amendments (Task 6)
- Callable symbols are kind function or method (function-valued consts have kind function). Any other symbol ->
  INVALID_ARGS "symbol has no call signature". Unknown symbol_id or compare_to -> UNKNOWN_SYMBOL.
- name = the symbol name ("Class.method" for methods). Overloads use the first declaration.
- type_signature = the same text as SymbolSummary.signature but without the 300-char cut.
- params, in order, excluding `this`: name = source text of the parameter's name node (so destructured params read
  like "{ a, b }"), whitespace collapsed, max 60 chars; type = the checker's type string for that parameter;
  optional = has "?", has an initializer, or is a rest parameter.
- return_type = the checker's string for the signature's return type (async functions show Promise<T>).
- type_params = source text of each type parameter node of the declaration (e.g. "T extends object = {}"),
  collapsed, max 100 chars each; [] if none.
- is_async = the declaration has the async modifier (not inferred from the return type). exported = symbol.exported.
- Every string derived from the checker passes scrubPaths -> redactSecrets -> collapse, and each type string is
  cut to 300 chars AFTER redaction.
- compat (only when compare_to is given) answers: could callers of A (the symbol) be switched to B (compare_to)?
    same_param_count: A and B have the same number of parameters (a rest parameter counts as one).
    params_assignable: false if B has more REQUIRED parameters than A has required parameters, or if A has a
      parameter at a position where B has none; otherwise true only if A's parameter type at every position is
      assignable to B's parameter type at that position; "unknown" if either signature has type parameters or a
      rest parameter, or if checker.isTypeAssignableTo is not available.
    return_assignable: B's return type is assignable to A's return type; "unknown" under the same conditions.
    async_match: A.is_async === B.is_async.
- If the serialized envelope exceeds 6144 bytes, return err("BUDGET_EXCEEDED", "signature too large"). Never silently
  drop parameters.

## Amendments (Task 6b)
If both a definite-false rule and an 'unknown' condition apply to params_assignable, 'unknown' wins.
return_assignable is also 'unknown' when either side has type parameters or a rest parameter (conservative).

## Amendments (Task 7)
- get_references uses service.findReferences(absFileName, sym.nameOffset) from the same Program/service that
  produced the symbols. Groups are flattened and deduplicated by (file, span start, span length).
- The symbol's own declaration is excluded. Import specifiers arrive as separate alias groups and are kept,
  because they are the "import" references.
- file is repo-relative with forward slashes; references outside the root are dropped. include_tests=false
  hides references whose own file is a test file.
- Kind is classified in this order: import (inside an import/export specifier or declaration), call (the
  reference is exactly the direct callee of a call/new expression), type_use (inside a type node), else
  other. "Direct callee" is strict: from the reference we climb only through a PropertyAccessExpression
  whose `.name` is the current node (so `ns.ping(1)` counts), a ParenthesizedExpression, or a
  NonNullExpression, and return call only when the parent is a CallExpression/NewExpression whose
  `.expression` is that node. Call arguments and call results never count (e.g. `foo(ping)(2)` and
  `app.use(handler).listen()` classify the inner reference as other).
- context = the reference's source line, trimmed, with scrubPaths then redaction applied, then cut to 200
  chars (never before redaction). enclosing_symbol_id = findEnclosing(file, offset), or null at the top level.
- total = every matching reference (the full count, unaffected by the by_file cap or limit). by_file counts
  matches per file, sorted by count descending then file ascending, and is capped at 20 entries;
  by_file_truncated = true when entries were dropped. references = the first `limit` (sorted by file then
  offset); truncated = true when the limit or the 6 KB byte cap dropped references. kinds, when given, keeps
  only the listed kinds and must be non-empty, so `kinds: []` is INVALID_ARGS.
- Output is validated with GetReferencesOutputSchema; the envelope is trimmed to 6 KB by dropping whole
  references from the end.
## CLI contract (Task 8)
- Entry point: run(argv, io) -> number. It returns the exit code and never calls process.exit or throws; every
  failure becomes a one-line message (or a JSON error envelope). io = {out:(s)=>void, err:(s)=>void}. The
  top-level code only sets process.exitCode from run(process.argv.slice(2), {out: console.log, err:
  console.error}), and only when the module is the process entry point, so importing it has no side effects.
- Exit codes: 0 success; 1 a tool returned an error envelope, or the root or index could not be built; 2 a
  usage error (unknown command, unknown flag, missing or extra positional, or a bad flag value).
- Flag validation: --limit and --max-lines must be positive integers, else exit 2, and a NaN is never passed
  to a tool. --kind must be one of function|method|class|interface|type|const. --kinds must be a non-empty
  comma-separated subset of call|import|type_use|other. An unknown flag reports "unknown option: <flag>",
  never the raw parseArgs error.
- Output discipline: human errors go to err as a single "error: <message>" line, never a stack trace. With
  --json, out receives exactly one line of JSON and nothing else: the tool envelope for search/def/refs/sig,
  or {"ok":false,"error":{"code":"USAGE","message":"..."}} for a usage error. --json governs the
  envelope-producing commands; stats is always the human report.
- Root problems: a missing --root directory gives "error: root directory not found: <path>"; a root with no
  TypeScript files gives "error: no TypeScript files found under: <path>". Both exit 1 (with --json they
  become an error envelope with code INVALID_ARGS).
- Help: --help prints usage to out and exits 0. No command prints usage to err and exits 2.
- Root paths: --root accepts relative paths, trailing separators and both slash styles (backslashes are
  normalized on POSIX).
