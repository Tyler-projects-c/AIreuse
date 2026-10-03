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
