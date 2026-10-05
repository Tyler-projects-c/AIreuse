import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { buildIndex, buildProject } from "./index.js";
import type { ProjectIndex, SymbolIndex } from "./index.js";
import { ReferenceKindSchema, SymbolKindSchema } from "./schemas.js";
import type {
  ErrorCode,
  GetDefinitionOutput,
  GetReferencesOutput,
  GetSignatureOutput,
  ResultEnvelope,
  SearchSymbolsOutput,
} from "./schemas.js";
import { createTools } from "./tools.js";

/** Sinks for human output. `out` is stdout, `err` is stderr. */
export interface CliIo {
  out: (s: string) => void;
  err: (s: string) => void;
}

export const USAGE = [
  "Usage: cli <command> [flags]",
  "Commands: stats, search <query...>, def <symbol_id>, refs <symbol_id>, sig <symbol_id>",
  "Flags: --root <dir>  --tsconfig <path>  --json  --symbols",
  "       --kind <kind>  --path-prefix <p>  --include-tests  --limit <n>",
  "       --max-lines <n>   (def)",
  "       --kinds <call,import,type_use,other>   (refs)",
  "       --compare-to <symbol_id>   (sig)",
].join("\n");

const OPTIONS = {
  root: { type: "string" },
  tsconfig: { type: "string" },
  json: { type: "boolean" },
  kind: { type: "string" },
  "path-prefix": { type: "string" },
  "include-tests": { type: "boolean" },
  limit: { type: "string" },
  "max-lines": { type: "string" },
  "compare-to": { type: "string" },
  kinds: { type: "string" },
  symbols: { type: "boolean" },
  help: { type: "boolean" },
} as const;

const SYMBOL_KINDS: readonly string[] = SymbolKindSchema.options;
const REFERENCE_KINDS: readonly string[] = ReferenceKindSchema.options;

/**
 * True when `--json` appears before the `--` separator, even if parsing the
 * rest of the argv fails. A usage error must still emit JSON when asked.
 */
function jsonRequested(argv: string[]): boolean {
  for (const arg of argv) {
    if (arg === "--") break;
    if (arg === "--json") return true;
  }
  return false;
}

/** Never surface the raw parseArgs message; keep it short and friendly. */
function friendlyParseError(error: unknown): string {
  const code =
    error !== null && typeof error === "object"
      ? (error as { code?: unknown }).code
      : undefined;
  const raw = error instanceof Error ? error.message : String(error);
  const match = /'([^']+)'/.exec(raw);
  const token = match ? match[1] : undefined;
  if (code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
    return token ? `unknown option: ${token}` : "unknown option";
  }
  if (code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE") {
    if (/argument missing/.test(raw)) {
      return token ? `missing value for ${token}` : "missing option value";
    }
    return token ? `invalid value for ${token}` : "invalid option value";
  }
  return raw;
}

function parseCli(argv: string[]):
  | {
      ok: true;
      values: {
        [K in keyof typeof OPTIONS]?: (typeof OPTIONS)[K] extends {
          type: "boolean";
        }
          ? boolean
          : string;
      };
      positionals: string[];
    }
  | { ok: false; message: string } {
  try {
    const parsed = parseArgs({
      args: argv,
      options: OPTIONS,
      allowPositionals: true,
      strict: true,
    });
    return { ok: true, values: parsed.values, positionals: parsed.positionals };
  } catch (error) {
    return { ok: false, message: friendlyParseError(error) };
  }
}

/** Accept Windows-style backslashes on every platform. */
function normalizeCliPath(raw: string): string {
  return path.sep === "\\" ? raw : raw.replace(/\\/g, "/");
}

function isDirectory(abs: string): boolean {
  try {
    return fs.statSync(abs).isDirectory();
  } catch {
    return false;
  }
}

function parsePositiveInt(
  raw: string,
  flag: string,
): { ok: true; value: number } | { ok: false; message: string } {
  const trimmed = raw.trim();
  if (!/^[0-9]+$/.test(trimmed)) {
    return { ok: false, message: `${flag} must be a positive integer` };
  }
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < 1) {
    return { ok: false, message: `${flag} must be a positive integer` };
  }
  return { ok: true, value };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  return String(error);
}

/**
 * Exit 2: usage error. With --json, stdout carries one USAGE error envelope;
 * otherwise the message (or the full usage when there is no message) goes to
 * stderr as a single line.
 */
function usageFailure(io: CliIo, asJson: boolean, message?: string): number {
  if (asJson) {
    const text = message ?? "usage error";
    io.out(
      JSON.stringify({ ok: false, error: { code: "USAGE", message: text } }),
    );
  } else if (message === undefined) {
    io.err(USAGE);
  } else {
    io.err(`error: ${message}`);
  }
  return 2;
}

/** Exit 1: the root/index could not be built or a tool returned an error. */
function failure(
  io: CliIo,
  asJson: boolean,
  message: string,
  code: ErrorCode = "INVALID_ARGS",
): number {
  if (asJson) {
    io.out(JSON.stringify({ ok: false, error: { code, message } }));
  } else {
    io.err(`error: ${message}`);
  }
  return 1;
}

/**
 * Render a tool envelope. With --json stdout gets exactly one JSON line, the
 * envelope itself; otherwise an error envelope is one stderr line and a
 * successful one is rendered by `renderHuman`.
 */
function emitEnvelope(
  io: CliIo,
  asJson: boolean,
  envelope: ResultEnvelope,
  renderHuman: (data: unknown) => void,
): number {
  if (!envelope.ok) {
    if (asJson) io.out(JSON.stringify(envelope));
    else io.err(`error: ${envelope.error.code}: ${envelope.error.message}`);
    return 1;
  }
  if (asJson) {
    io.out(JSON.stringify(envelope));
    return 0;
  }
  renderHuman(envelope.data);
  return 0;
}

function renderStats(
  out: (s: string) => void,
  project: ProjectIndex,
  index: SymbolIndex,
  showSymbols: boolean,
): void {
  out(`TypeScript: ${project.tsVersion} (${project.tsSource})`);
  out(
    `tsconfig: ${
      project.tsconfigPath
        ? path.relative(process.cwd(), project.tsconfigPath).replace(/\\/g, "/")
        : "(none, default options)"
    }`,
  );
  if (project.tsconfigWarning) {
    out(`warning: ${project.tsconfigWarning}`);
  }
  out(`root: ${project.root.replace(/\\/g, "/")}`);
  out(`indexable files: ${project.files.length}`);
  for (const f of project.files.slice(0, 20)) {
    out(`  ${f}`);
  }
  if (project.files.length > 20) {
    out(`  ... and ${project.files.length - 20} more`);
  }
  out("denied files by reason:");
  const entries = Object.entries(project.deniedByReason).sort((a, b) =>
    a[0] < b[0] ? -1 : 1,
  );
  if (entries.length === 0) {
    out("  (none)");
  } else {
    for (const [reason, count] of entries) {
      out(`  ${reason}: ${count}`);
    }
  }
  out("skipped directories:");
  const skipped = Object.entries(project.skippedDirs).sort((a, b) =>
    a[0] < b[0] ? -1 : 1,
  );
  if (skipped.length === 0) {
    out("  (none)");
  } else {
    for (const [name, count] of skipped) {
      out(`  ${name}: ${count}`);
    }
  }
  out("symbols:");
  const all = index.all();
  const byKind: Record<string, number> = {};
  let nonTest = 0;
  let testCount = 0;
  for (const s of all) {
    byKind[s.kind] = (byKind[s.kind] ?? 0) + 1;
    if (s.is_test) testCount++;
    else nonTest++;
  }
  for (const kind of [
    "function",
    "method",
    "class",
    "interface",
    "type",
    "const",
  ]) {
    out(`  ${kind}: ${byKind[kind] ?? 0}`);
  }
  out(`  non-test: ${nonTest}  test: ${testCount}`);
  if (showSymbols) {
    for (const s of all) {
      const tags = `${s.exported ? "  [exported]" : ""}${s.is_test ? "  [test]" : ""}`;
      out(
        `${s.symbol_id}  ${s.file}:${s.line}  ${s.kind}  ${s.name}${tags}  ${s.signature}`,
      );
    }
  }
}

function renderSearch(out: (s: string) => void, data: SearchSymbolsOutput): void {
  if (data.results.length === 0) {
    out("(no results)");
    return;
  }
  for (const r of data.results) {
    out(`${r.symbol_id}  ${r.kind}  ${r.name}  ${r.file}:${r.line}  ${r.signature}`);
  }
  if (data.truncated) out("(truncated)");
}

function renderDefinition(
  out: (s: string) => void,
  data: GetDefinitionOutput,
): void {
  const tags = `${data.symbol.exported ? "  [exported]" : ""}${
    data.deprecated ? "  [deprecated]" : ""
  }`;
  out(
    `${data.symbol.symbol_id}  ${data.symbol.kind}  ${data.symbol.name}  ` +
      `${data.symbol.file}:${data.range.start_line}-${data.range.end_line}${tags}`,
  );
  out(data.symbol.signature);
  for (const imp of data.imports_used) {
    out(`import ${imp.module}: ${imp.names.join(", ")}`);
  }
  out("");
  out(data.body);
  if (data.body_truncated) {
    const shown = data.body.split("\n").length;
    out(`(truncated: showing ${shown} of ${data.line_count} lines)`);
  }
}

function renderReferences(
  out: (s: string) => void,
  data: GetReferencesOutput,
): void {
  out(`${data.total} reference(s)${data.truncated ? " (truncated)" : ""}`);
  for (const r of data.references) {
    const owner = r.enclosing_symbol_id ? `  [in ${r.enclosing_symbol_id}]` : "";
    out(`${r.file}:${r.line}  ${r.kind}${owner}  ${r.context}`);
  }
}

function renderSignature(
  out: (s: string) => void,
  index: SymbolIndex,
  symbolId: string,
  compareTo: string | undefined,
  data: GetSignatureOutput,
): void {
  // The tool already validated symbol_id, so this lookup cannot fail.
  const sym = index.getById(symbolId);
  const tags = `${data.exported ? "  [exported]" : ""}${
    data.is_async ? "  [async]" : ""
  }`;
  out(`${sym ? sym.symbol_id : "?"}  ${sym ? sym.kind : "?"}  ${data.name}${tags}`);
  out(data.type_signature);
  for (const p of data.params) {
    out(`  ${p.name}${p.optional ? "?" : ""}: ${p.type}`);
  }
  out(`returns: ${data.return_type}`);
  if (data.type_params.length > 0) {
    out(`type params: ${data.type_params.join(", ")}`);
  }
  if (data.compat) {
    out(
      `compat vs ${compareTo ?? "?"}: ` +
        `same_param_count=${data.compat.same_param_count} ` +
        `params_assignable=${data.compat.params_assignable} ` +
        `return_assignable=${data.compat.return_assignable} ` +
        `async_match=${data.compat.async_match}`,
    );
  }
}

/**
 * Run one CLI invocation. Returns the process exit code (0 ok, 1 tool/root
 * failure, 2 usage error) and never calls process.exit or throws.
 */
export function run(argv: string[], io: CliIo): number {
  const wantsJson = jsonRequested(argv);

  const parsed = parseCli(argv);
  if (!parsed.ok) return usageFailure(io, wantsJson, parsed.message);
  const { values, positionals } = parsed;
  const asJson = values.json === true;

  if (values.help === true) {
    io.out(USAGE);
    return 0;
  }

  const command = positionals[0];
  if (command === undefined) {
    return usageFailure(io, asJson);
  }

  // Positional arity. These are usage errors and must beat any build work.
  if (command === "stats") {
    if (positionals.length > 1) {
      return usageFailure(io, asJson, `unexpected extra argument: ${positionals[1]}`);
    }
  } else if (command === "search") {
    if (positionals.length < 2) {
      return usageFailure(io, asJson, "search requires a query");
    }
  } else if (command === "def" || command === "refs" || command === "sig") {
    if (positionals.length < 2) {
      return usageFailure(io, asJson, `${command} requires a symbol_id`);
    }
    if (positionals.length > 2) {
      return usageFailure(io, asJson, `unexpected extra argument: ${positionals[2]}`);
    }
  } else {
    return usageFailure(io, asJson, `unknown command: ${command}`);
  }

  // Numeric flags are validated here so a NaN never reaches a tool.
  let limit: number | undefined;
  if (values.limit !== undefined) {
    const parsedLimit = parsePositiveInt(values.limit, "--limit");
    if (!parsedLimit.ok) return usageFailure(io, asJson, parsedLimit.message);
    limit = parsedLimit.value;
  }
  let maxLines: number | undefined;
  if (values["max-lines"] !== undefined) {
    const parsedMax = parsePositiveInt(values["max-lines"], "--max-lines");
    if (!parsedMax.ok) return usageFailure(io, asJson, parsedMax.message);
    maxLines = parsedMax.value;
  }

  // Enum flags.
  if (values.kind !== undefined && !SYMBOL_KINDS.includes(values.kind)) {
    return usageFailure(
      io,
      asJson,
      `--kind must be one of: ${SYMBOL_KINDS.join(", ")}`,
    );
  }
  let refKinds: string[] | undefined;
  if (values.kinds !== undefined) {
    const parts = values.kinds
      .split(",")
      .map((k) => k.trim())
      .filter((k) => k.length > 0);
    if (parts.length === 0 || parts.some((p) => !REFERENCE_KINDS.includes(p))) {
      return usageFailure(
        io,
        asJson,
        `--kinds must be a comma-separated list of: ${REFERENCE_KINDS.join(", ")}`,
      );
    }
    refKinds = parts;
  }

  const root = path.resolve(normalizeCliPath(values.root ?? "."));
  if (!isDirectory(root)) {
    return failure(io, asJson, `root directory not found: ${root}`);
  }
  const tsconfig =
    values.tsconfig !== undefined ? normalizeCliPath(values.tsconfig) : undefined;
  const buildOpts = tsconfig !== undefined ? { tsconfig } : undefined;

  try {
    const project = buildProject(root, buildOpts);
    if (project.files.length === 0) {
      return failure(io, asJson, `no TypeScript files found under: ${root}`);
    }
    const index = buildIndex(project);

    if (command === "stats") {
      renderStats(io.out, project, index, values.symbols === true);
      return 0;
    }

    const tools = createTools(index);

    if (command === "search") {
      const input: Record<string, unknown> = {
        query: positionals.slice(1).join(" "),
      };
      if (values.kind !== undefined) input.kind = values.kind;
      if (values["path-prefix"] !== undefined) {
        input.path_prefix = values["path-prefix"];
      }
      if (values["include-tests"] === true) input.include_tests = true;
      if (limit !== undefined) input.limit = limit;
      return emitEnvelope(io, asJson, tools.search_symbols(input), (data) =>
        renderSearch(io.out, data as SearchSymbolsOutput),
      );
    }

    if (command === "def") {
      const input: Record<string, unknown> = { symbol_id: positionals[1] };
      if (maxLines !== undefined) input.max_lines = maxLines;
      return emitEnvelope(io, asJson, tools.get_definition(input), (data) =>
        renderDefinition(io.out, data as GetDefinitionOutput),
      );
    }

    if (command === "refs") {
      const input: Record<string, unknown> = { symbol_id: positionals[1] };
      if (refKinds !== undefined) input.kinds = refKinds;
      if (values["include-tests"] === true) input.include_tests = true;
      if (limit !== undefined) input.limit = limit;
      return emitEnvelope(io, asJson, tools.get_references(input), (data) =>
        renderReferences(io.out, data as GetReferencesOutput),
      );
    }

    // sig
    const symbolId = positionals[1];
    const compareTo = values["compare-to"];
    const input: Record<string, unknown> = { symbol_id: symbolId };
    if (compareTo !== undefined) input.compare_to = compareTo;
    return emitEnvelope(io, asJson, tools.get_signature(input), (data) =>
      renderSignature(io.out, index, symbolId, compareTo, data as GetSignatureOutput),
    );
  } catch (error) {
    return failure(io, asJson, errorMessage(error));
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return (
      fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

// Top-level wiring only: argv in, console sinks, exit code out. Guarded so
// importing this module (e.g. in tests) has no side effects.
if (isMainModule()) {
  process.exitCode = run(process.argv.slice(2), {
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  });
}
