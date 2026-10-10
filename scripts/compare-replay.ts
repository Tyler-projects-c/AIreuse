/**
 * Task 10 comparison (Step 4.2). Reads docs/task10/before.json and
 * docs/task10/after.json — produced by scripts/replay.ts with identical
 * queries and canonicals — and prints a markdown table plus a per-case
 * improved/unchanged/regressed summary.
 *
 * Usage: npx tsx scripts/compare-replay.ts
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

interface Row {
  case: string;
  qid: string;
  term: string;
  results: number;
  truncated: boolean;
  rank: number | null;
  matched: { name: string; file: string } | null;
  error?: string;
}

interface Doc {
  root: string;
  limit: number;
  queries: Row[];
}

function load(name: string): Doc {
  return JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, "docs", "task10", name), "utf8"),
  ) as Doc;
}

const before = load("before.json");
const after = load("after.json");

if (before.queries.length !== after.queries.length) {
  throw new Error("before/after query counts differ");
}

const fmtRank = (r: number | null): string => (r === null ? "—" : String(r));

function rankDelta(b: number | null, a: number | null): string {
  if (b === null && a === null) return "none";
  if (b === null && a !== null) return "**new**";
  if (b !== null && a === null) return "**LOST**";
  if (a === b) return "same";
  return a < b ? `up ${b - a}` : `**down ${a - b}**`;
}

console.log("| case | qid | query | before (rank/total) | after (rank/total) | Δrank | Δtotal |");
console.log("|---|---|---|---|---|---|---|");
for (let i = 0; i < before.queries.length; i++) {
  const b = before.queries[i] as Row;
  const a = after.queries[i] as Row;
  if (b.term !== a.term || b.case !== a.case) {
    throw new Error(`row ${i} mismatch: ${b.term} vs ${a.term}`);
  }
  const dt = a.results - b.results;
  console.log(
    `| ${b.case} | ${b.qid} | \`${b.term}\` | ${fmtRank(b.rank)}/${b.results} | ${fmtRank(a.rank)}/${a.results} | ${rankDelta(b.rank, a.rank)} | ${dt === 0 ? "0" : dt > 0 ? `+${dt}` : String(dt)} |`,
  );
}

const cases = [...new Set(before.queries.map((q) => q.case))];
console.log("\n### Per case\n");
console.log("| case | canonical | best rank before | best rank after | verdict |");
console.log("|---|---|---|---|---|");
const NONE = Number.POSITIVE_INFINITY;
for (const c of cases) {
  const rowsB = before.queries.filter((q) => q.case === c);
  const rowsA = after.queries.filter((q) => q.case === c);
  const best = (rows: Row[]): number | null => {
    let m = NONE;
    for (const r of rows) if (r.rank !== null && r.rank < m) m = r.rank;
    return m === NONE ? null : m;
  };
  const bb = best(rowsB);
  const ba = best(rowsA);
  const canonical = (() => {
    const m = [...rowsB, ...rowsA].find((r) => r.matched);
    return m ? `${m.matched.name} (${m.matched.file})` : "unindexed (nested local)";
  })();
  let kind: string;
  if (bb === null && ba === null) kind = "unchanged (never surfaced)";
  else if (bb === null) kind = "improved (newly surfaced)";
  else if (ba === null) kind = "REGRESSED (lost)";
  else if (ba < bb) kind = "improved";
  else if (ba === bb) kind = "unchanged";
  else kind = "REGRESSED (pushed down)";
  console.log(
    `| ${c} | ${canonical} | ${bb ?? "—"} | ${ba ?? "—"} | ${kind} |`,
  );
}
