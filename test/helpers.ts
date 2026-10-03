import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function makeTempProject(
  files: Record<string, string>,
  opts?: { git?: boolean },
): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aireuse-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  }
  if (opts?.git) {
    execSync("git init", { cwd: dir, stdio: "ignore" });
  }
  return dir;
}
