import path from "node:path";
import { parseArgs } from "node:util";
import { buildIndex, buildProject, toForwardSlashes } from "./index.js";
import type { ProjectIndex, SymbolIndex } from "./index.js";
import type { GetDefinitionOutput, SearchSymbolsOutput } from "./schemas.js";
import { createTools } from "./tools.js";

function printUsage(): void {
  console.log("Usage: cli <command> [flags]");
  console.log("Commands: stats, search <query...>, def <symbol_id>");
  console.log("Flags: --root <dir>  --tsconfig <path>  --json  --symbols");
  console.log(
    "       --kind <kind>  --path-prefix <p>  --include-tests  --limit <n>",
  );
  console.log("       --max-lines <n>   (def)");
}

function printStats(
  project: ProjectIndex,
  index: SymbolIndex,
  showSymbols: boolean,
): void {
  console.log(`TypeScript: ${project.tsVersion} (${project.tsSource})`);
  console.log(
    `tsconfig: ${
      project.tsconfigPath
        ? toForwardSlashes(path.relative(process.cwd(), project.tsconfigPath))
        : "(none, default options)"
    }`,
  );
  if (project.tsconfigWarning) {
    console.log(`warning: ${project.tsconfigWarning}`);
  }
  console.log(`root: ${toForwardSlashes(project.root)}`);
  console.log(`indexable files: ${project.files.length}`);
  for (const f of project.files.slice(0, 20)) {
    console.log(`  ${f}`);
  }
  if (project.files.length > 20) {
    console.log(`  ... and ${project.files.length - 20} more`);
  }
  console.log("denied files by reason:");
  const entries = Object.entries(project.deniedByReason).sort((a, b) =>
    a[0] < b[0] ? -1 : 1,
  );
  if (entries.length === 0) {
    console.log("  (none)");
  } else {
    for (const [reason, count] of entries) {
      console.log(`  ${reason}: ${count}`);
    }
  }
  console.log("skipped directories:");
  const skipped = Object.entries(project.skippedDirs).sort((a, b) =>
    a[0] < b[0] ? -1 : 1,
  );
  if (skipped.length === 0) {
    console.log("  (none)");
  } else {
    for (const [name, count] of skipped) {
      console.log(`  ${name}: ${count}`);
    }
  }
  console.log("symbols:");
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
    console.log(`  ${kind}: ${byKind[kind] ?? 0}`);
  }
  console.log(`  non-test: ${nonTest}  test: ${testCount}`);
  if (showSymbols) {
    for (const s of all) {
      const tags = `${s.exported ? "  [exported]" : ""}${s.is_test ? "  [test]" : ""}`;
      console.log(
        `${s.symbol_id}  ${s.file}:${s.line}  ${s.kind}  ${s.name}${tags}  ${s.signature}`,
      );
    }
  }
}

function main(): void {
  let parsedArgs;
  try {
    parsedArgs = parseArgs({
      args: process.argv.slice(2),
      options: {
        root: { type: "string" },
        tsconfig: { type: "string" },
        json: { type: "boolean" },
        kind: { type: "string" },
        "path-prefix": { type: "string" },
        "include-tests": { type: "boolean" },
        limit: { type: "string" },
        "max-lines": { type: "string" },
        symbols: { type: "boolean" },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch {
    printUsage();
    process.exitCode = 1;
    return;
  }
  const { values, positionals } = parsedArgs;
  const root = path.resolve(values.root ?? ".");
  const tsconfig = values.tsconfig;
  const buildOpts = tsconfig ? { tsconfig } : undefined;
  const command = positionals[0];

  if (command === "stats") {
    const project = buildProject(root, buildOpts);
    const index = buildIndex(project);
    printStats(project, index, values.symbols === true);
    return;
  }

  if (command === "search") {
    const project = buildProject(root, buildOpts);
    const index = buildIndex(project);
    const tools = createTools(index);
    const input: Record<string, unknown> = {
      query: positionals.slice(1).join(" "),
    };
    if (values.kind !== undefined) input.kind = values.kind;
    if (values["path-prefix"] !== undefined) {
      input.path_prefix = values["path-prefix"];
    }
    if (values["include-tests"] === true) input.include_tests = true;
    if (values.limit !== undefined) input.limit = Number(values.limit);
    const envelope = tools.search_symbols(input);
    const asJson = values.json === true;
    if (!envelope.ok) {
      if (asJson) {
        console.log(JSON.stringify(envelope));
      } else {
        console.error(`error: ${envelope.error.code}: ${envelope.error.message}`);
      }
      process.exitCode = 1;
      return;
    }
    if (asJson) {
      console.log(JSON.stringify(envelope));
      return;
    }
    const data = envelope.data as SearchSymbolsOutput;
    if (data.results.length === 0) {
      console.log("(no results)");
      return;
    }
    for (const r of data.results) {
      console.log(
        `${r.symbol_id}  ${r.kind}  ${r.name}  ${r.file}:${r.line}  ${r.signature}`,
      );
    }
    if (data.truncated) console.log("(truncated)");
    return;
  }

  if (command === "def") {
    const project = buildProject(root, buildOpts);
    const index = buildIndex(project);
    const tools = createTools(index);
    const input: Record<string, unknown> = {};
    if (positionals[1] !== undefined) input.symbol_id = positionals[1];
    if (values["max-lines"] !== undefined) {
      input.max_lines = Number(values["max-lines"]);
    }
    const envelope = tools.get_definition(input);
    const asJson = values.json === true;
    if (!envelope.ok) {
      if (asJson) {
        console.log(JSON.stringify(envelope));
      } else {
        console.error(`error: ${envelope.error.code}: ${envelope.error.message}`);
      }
      process.exitCode = 1;
      return;
    }
    if (asJson) {
      console.log(JSON.stringify(envelope));
      return;
    }
    const data = envelope.data as GetDefinitionOutput;
    const tags = `${data.symbol.exported ? "  [exported]" : ""}${
      data.deprecated ? "  [deprecated]" : ""
    }`;
    console.log(
      `${data.symbol.symbol_id}  ${data.symbol.kind}  ${data.symbol.name}  ` +
        `${data.symbol.file}:${data.range.start_line}-${data.range.end_line}${tags}`,
    );
    console.log(data.symbol.signature);
    for (const imp of data.imports_used) {
      console.log(`import ${imp.module}: ${imp.names.join(", ")}`);
    }
    console.log("");
    console.log(data.body);
    if (data.body_truncated) {
      const shown = data.body.split("\n").length;
      console.log(`(truncated: showing ${shown} of ${data.line_count} lines)`);
    }
    return;
  }

  printUsage();
  process.exitCode = 1;
}

main();
