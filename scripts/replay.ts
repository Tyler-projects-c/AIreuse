/**
 * Task 10 replay harness (Step 0.4 / Step 4.1).
 *
 * Runs every search term in docs/task10/queries.json through the CLI — the
 * real `run()` entry point from src/cli.ts with `--json --limit 10` — against
 * a fixed index root, and records per query the number of results and the
 * 1-based rank (or null) of that case's canonical symbol.
 *
 * The canonical is identified by NAME + FILE, never by symbol_id. Canonical
 * names are used only to *read* ranks; they never form a query. Queries and
 * canonicals are frozen between the before/after runs.
 *
 * Usage: npx tsx scripts/replay.ts <out.json> [--root <dir>]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../src/cli.js";
import type { CliIo } from "../src/cli.js";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const DEFAULT_ROOT = path.resolve(REPO_ROOT, "..", "PD-scratch");
const LIMIT = 10;

interface QueryEntry {
  case: string;
  qid: string;
  term: string;
}

interface Canonical {
  name: string;
  file: string;
  /** True when the canonical is not an indexed symbol by construction. */
  unindexed?: boolean;
}

/**
 * Canonical (expected duplicate) symbol per case, taken verbatim from
 * docs/PRE_STEP2_VALIDATION.md §2. N1-N3 track the "superficially similar
 * existing" symbol from §4.
 */
const CANONICALS: Record<string, Canonical> = {
  C1: { name: "utcDayStart", file: "app/utils/product-surface-stats.server.ts" },
  C2: { name: "round2", file: "app/utils/order-verification.server.ts" },
  C3: { name: "encryptToken", file: "app/utils/crypto.server.ts" },
  C4: {
    name: "shouldAlertToSentry",
    file: "app/utils/alert-throttle.server.ts",
  },
  C5: { name: "effectiveRevenue", file: "app/utils/verified-revenue.ts" },
  C6: { name: "DEFAULT_WINDOW_DAYS", file: "app/utils/attribution.server.ts" },
  C7: {
    name: "formatRatio",
    file: "app/utils/insights.ts",
    unindexed: true,
  },
  N1: { name: "utcDayStart", file: "app/utils/product-surface-stats.server.ts" },
  N2: { name: "lineProductId", file: "app/utils/order-verification.server.ts" },
  N3: { name: "round2", file: "app/utils/order-verification.server.ts" },
};

interface QueryResult {
  case: string;
  qid: string;
  term: string;
  /** Number of results the CLI returned (<= limit, further cut by the 6 KB cap). */
  results: number;
  truncated: boolean;
  /** 1-based rank of the canonical in the returned results, or null. */
  rank: number | null;
  /** Name/file of the result that was matched as the canonical, or null. */
  matched: { name: string; file: string } | null;
  /** Set when the envelope was an error instead of results. */
  error?: string;
}

function searchViaCli(root: string, term: string): {
  data?: { results: { name: string; file: string }[]; truncated: boolean };
  error?: string;
} {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { out: (s) => out.push(s), err: (s) => err.push(s) };
  const code = run(
    ["search", term, "--json", "--root", root, "--limit", String(LIMIT)],
    io,
  );
  if (out.length !== 1) {
    return {
      error: `expected exactly one JSON line, got ${out.length} (exit ${code}): ${err.join(" | ")}`,
    };
  }
  let parsed: {
    ok: boolean;
    data?: { results: { name: string; file: string }[]; truncated: boolean };
    error?: { code: string; message: string };
  };
  try {
    parsed = JSON.parse(out[0] as string);
  } catch (e) {
    return { error: `unparseable CLI output: ${String(e)}` };
  }
  if (!parsed.ok) {
    return {
      error: `CLI error ${parsed.error?.code}: ${parsed.error?.message}`,
    };
  }
  if (!parsed.data) return { error: "CLI ok envelope had no data" };
  return { data: parsed.data };
}

function main(): void {
  const args = process.argv.slice(2);
  const outPath = args.find((a) => !a.startsWith("--"));
  if (!outPath) {
    console.error("usage: npx tsx scripts/replay.ts <out.json> [--root <dir>]");
    process.exitCode = 2;
    return;
  }
  const rootFlag = args.indexOf("--root");
  const root =
    rootFlag !== -1 && args[rootFlag + 1] !== undefined
      ? path.resolve(args[rootFlag + 1] as string)
      : DEFAULT_ROOT;

  const queries = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, "docs", "task10", "queries.json"), "utf8"),
  ) as QueryEntry[];
  if (queries.length !== 33) {
    throw new Error(`expected 33 frozen queries, found ${queries.length}`);
  }

  const rows: QueryResult[] = [];
  for (const q of queries) {
    const canonical = CANONICALS[q.case];
    if (!canonical) throw new Error(`no canonical recorded for case ${q.case}`);
    const { data, error } = searchViaCli(root, q.term);
    if (error !== undefined) {
      rows.push({
        case: q.case,
        qid: q.qid,
        term: q.term,
        results: 0,
        truncated: false,
        rank: null,
        matched: null,
        error,
      });
      continue;
    }
    const results = data?.results ?? [];
    let idx = -1;
    if (!canonical.unindexed) {
      idx = results.findIndex(
        (r) => r.name === canonical.name && r.file === canonical.file,
      );
    }
    rows.push({
      case: q.case,
      qid: q.qid,
      term: q.term,
      results: results.length,
      truncated: data?.truncated ?? false,
      rank: idx === -1 ? null : idx + 1,
      matched:
        idx === -1
          ? null
          : { name: results[idx]!.name, file: results[idx]!.file },
    });
  }

  const doc = {
    root: root.replace(/\\/g, "/"),
    limit: LIMIT,
    includeTests: false,
    canonical: CANONICALS,
    queries: rows,
  };
  const target = path.resolve(REPO_ROOT, outPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  console.log(`wrote ${path.relative(REPO_ROOT, target)} (${rows.length} queries)`);
  for (const r of rows) {
    console.log(
      `${r.case} ${r.qid} "${r.term}" -> results=${r.results} rank=${r.rank ?? "null"}${
        r.error ? ` ERROR ${r.error}` : ""
      }`,
    );
  }
}

main();
