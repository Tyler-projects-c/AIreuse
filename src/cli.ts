import path from "node:path";
import { buildIndex, buildProject, toForwardSlashes } from "./index.js";

function getFlag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function printUsage(): void {
  console.log("Usage: cli <command> [flags]");
  console.log("Commands: stats");
  console.log("Flags: --root <dir>  --tsconfig <path>  --symbols");
}

const command = process.argv[2];
const rest = process.argv.slice(3);

if (command === "stats") {
  const root = path.resolve(getFlag(rest, "--root") ?? ".");
  const tsconfig = getFlag(rest, "--tsconfig");
  const project = buildProject(root, tsconfig ? { tsconfig } : undefined);
  const index = buildIndex(project);
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
  for (const kind of ["function", "method", "class", "interface", "type", "const"]) {
    console.log(`  ${kind}: ${byKind[kind] ?? 0}`);
  }
  console.log(`  non-test: ${nonTest}  test: ${testCount}`);
  if (hasFlag(rest, "--symbols")) {
    for (const s of index.all()) {
      const tags = `${s.exported ? "  [exported]" : ""}${s.is_test ? "  [test]" : ""}`;
      console.log(
        `${s.symbol_id}  ${s.file}:${s.line}  ${s.kind}  ${s.name}${tags}  ${s.signature}`,
      );
    }
  }
} else {
  printUsage();
  process.exitCode = 1;
}
