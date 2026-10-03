import path from "node:path";
import { buildProject, toForwardSlashes } from "./index.js";

function getFlag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

function printUsage(): void {
  console.log("Usage: cli <command> [flags]");
  console.log("Commands: stats");
  console.log("Flags: --root <dir>  --tsconfig <path>");
}

const command = process.argv[2];
const rest = process.argv.slice(3);

if (command === "stats") {
  const root = path.resolve(getFlag(rest, "--root") ?? ".");
  const tsconfig = getFlag(rest, "--tsconfig");
  const project = buildProject(root, tsconfig ? { tsconfig } : undefined);
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
} else {
  printUsage();
  process.exitCode = 1;
}
