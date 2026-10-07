# Real-repo validation (Task 9)

## Target repo and date

- Target repo: `../PD` (Shopify app monorepo, sibling checkout of this tool's repo)
  - Indexed root: `C:/Users/Vigneshwaran/Documents/GitHub/PD`
  - `tsconfig`: `../PD/tsconfig.json`
  - Indexable files: **42** (denied: 3 `dts-file`, 24 `gitignored`, 21 `not-in-tsconfig`)
  - Indexed symbols: **233** (function 121, method 0, class 0, interface 31, type 7, const 74; test 0)
- Tool under test: this repo's CLI (`npx tsx src/cli.ts`), TypeScript 5.9.3 resolved from the workspace.
- Date: **2026-10-07**
- Method: every number below is the tool's own output, captured verbatim. Where a comparison with VS Code "Find All References" is given, it is labeled and derived only from cases the user checked by hand. Nothing here claims general parity with VS Code.

## Commands run

All commands were run from the AIreuse repo root, against `--root ../PD`.

| # | Purpose | Command |
|---|---------|---------|
| 1 | Index summary | `npx tsx src/cli.ts stats --root ../PD` |
| 2 | Zero-reference symbol | `npx tsx src/cli.ts refs s_221 --root ../PD --json` |
| 3 | High-use symbol (raises the per-file/reference caps) | `npx tsx src/cli.ts refs s_120 --root ../PD --limit 20 --json` |
| 4 | Second high-use symbol | `npx tsx src/cli.ts refs s_121 --root ../PD --limit 20 --json` |
| 5 | Call vs mere mention | `npx tsx src/cli.ts refs s_98 --root ../PD --json` |
| 6 | Partial-term search matching several symbols | `npx tsx src/cli.ts search log --root ../PD --limit 10 --json` |
| 7 | Partial-term search (name-only matches) | `npx tsx src/cli.ts search rank --root ../PD --limit 10 --json` |
| 8 | Signature compatibility | `npx tsx src/cli.ts sig s_106 --compare-to s_107 --root ../PD --json` |
| 9 | Manual-reference cases | `npx tsx src/cli.ts refs s_106 --root ../PD --json`, `npx tsx src/cli.ts refs s_201 --root ../PD --json` |
| 10 | Wall clock | `powershell -NoProfile -Command "$t = Measure-Command { npx.cmd tsx src/cli.ts stats --root ../PD \| Out-Null }; $t.TotalSeconds"` |

Symbol ids referenced above: `s_221` `sampleBetaForCandidate`, `s_120` `logWarn`, `s_121` `logError`, `s_98` `computeAttribution`, `s_106` `encryptToken`, `s_107` `decryptToken`, `s_201` `DailyRankingStore`, `s_36` `ErrorBoundary`.

## Results table

"Ours" = references returned by `refs`, which never includes the declaration and never counts comment text. "VS Code minus declaration" = what the user's Find All References pane showed, minus the declaration line.

| Symbol | Ours | VS Code minus declaration | Match |
|--------|------|---------------------------|-------|
| `sampleBetaForCandidate` (`s_221`, unused exported function) | **0** | 0 (only the declaration exists in the repo) | yes |
| `logWarn` (`s_120`, high use) | **40** across **16** files | _placeholder — to be filled in by user_ | _placeholder_ |
| `computeAttribution` (`s_98`, call vs mention) | **3** (1 `import`, 1 `type_use`, 1 `call`) | _placeholder — to be filled in by user_ | _placeholder_ |
| `encryptToken` (`s_106`) | **2** (`import` @ `app/routes/auth.$.tsx:6`, `call` @ `:16`) | 2 (VS Code showed 3 = declaration + the same 2) | yes |
| `DailyRankingStore` (`s_201`) | **3** (`type_use` @ `thompson-daily-cache.ts:67`, `import` @ `thompson-ranking.server.ts:40`, `type_use` @ `:66`) | 3 (VS Code showed 4 = declaration + the same 3) | yes |
| `ErrorBoundary` (`s_36`, second zero-reference data point) | **0** | 0 (route-convention export, referenced by the framework, not by code) | yes |

Detail for the two placeholder rows:

- **`logWarn` high use.** `total: 40`, `by_file_truncated: false`, `truncated: true` at `--limit 20`. Composition: 16 file-local imports + 24 call sites, spread over 16 files. Busiest files: `app/utils/product-sync.server.ts` 11, `app/utils/order-verification.server.ts` 8, `app/routes/api.proxy.$.tsx` 4, `app/routes/api.events.tsx` 3, then twelve files with 1–2. Honest framing: this exercises multi-file aggregation and the reference-list cap (`limit`), but it does **not** reach the 20-*file* `by_file` cap — see the known gaps.
- **`computeAttribution` call vs mention.** One symbol with three distinct kinds:
  - `app/utils/product-surface-stats.server.ts:41` — `import`
  - `app/utils/product-surface-stats.server.ts:63` — `type_use` — `attribution: Awaited<ReturnType<typeof computeAttribution>>;`
  - `app/utils/product-surface-stats.server.ts:202` — `call` — `const attribution = await computeAttribution({`
  - The four comment-only mentions of the name (lines 16, 21, 113, 200) are not counted.
  - PD contains no indexed function that is *passed as a value* (no `arr.map(fn)`, no `onClick={fn}` on an indexed symbol), so the closest genuine mention case is the `typeof` use above; it is correctly separated from the direct call.

## Signature compatibility

`sig s_106 --compare-to s_107 --root ../PD --json` (`encryptToken` vs `decryptToken`):

```json
{"ok":true,"data":{"name":"encryptToken","type_signature":"encryptToken(plain: string): string","params":[{"name":"plain","type":"string","optional":false}],"return_type":"string","type_params":[],"is_async":false,"exported":true,"compat":{"same_param_count":true,"params_assignable":true,"return_assignable":true,"async_match":true}}}
```

All four compatibility fields are `true`: `same_param_count`, `params_assignable`, `return_assignable`, `async_match`.

**Structural compatibility is not semantic equivalence.** This result means the two signatures are structurally interchangeable (`(string) => string`, same arity, non-async) as judged from TypeScript types. It says nothing about behavior: `decryptToken` is the inverse of `encryptToken`, not a substitute for it, and no runtime or intent check is performed. Treat `compat` as a type-shape report only.

## Timing

Full `stats` run on PD (process spawn + `tsx` transpile + tsconfig/program build + walk + index + render), measured with PowerShell `Measure-Command`, three consecutive runs:

| Run | Seconds |
|-----|---------|
| 1 | 4.2132353 |
| 2 | 4.0984328 |
| 3 | 4.1292416 |

Range 4.10–4.21 s (mean ≈ 4.15 s). This includes `npx.cmd`/`tsx` startup, so it is wall clock for the CLI, not for indexing alone.

## Known gaps / observations

1. **The 20-file `by_file` cap was not exercised on PD.** `by_file_truncated` becomes `true` only when a symbol is referenced from more than 20 distinct files. The most-spread symbols in PD are `logError` (`s_121`: 37 references over **17** files) and `logWarn` (`s_120`: 40 over **16**); `by_file_truncated` was `false` for both. Triggering it needs a symbol imported in >20 files. `truncated` (the reference-list `--limit`) was exercised (`total: 40` vs `limit: 20`).
2. **Nested/local declarations are not indexed.** `const enableTracking = () => …` inside the `Index` component (`app/routes/app._index.tsx:31`) is absent from the index: `search enableTracking` returns zero results and it cannot be queried with `refs`. Indexing is module/top-level scope only — top-level arrow consts *are* indexed (`loader`, `action`, `headers` appear with `kind: "function"`). Not a crash, but a coverage limit worth knowing before trusting a "no results" answer for a component-local helper.
3. **No bare-callback case exists in PD.** No indexed function is passed as a value, so the requested "direct call vs callback" contrast was approximated with a `typeof` mention in type position (`type_use`) instead of a JSX/`.map()` argument (`other`). The `other` kind is therefore untested against this repo; the `MODULE_RANK` const (`s_22`) does show 4 `other` references (object-property values) if that kind needs a real sample.
4. **Comments are excluded from references — verified.** `computeAttribution` has 4 comment-only mentions; none appear in the 3 references. Same shape for `logWarn` (0 comment-only lines among its 41 textual occurrences).
5. **The declaration is never counted as a reference.** Consistent for all cases here; VS Code's pane includes it, which is exactly the +1 difference seen on `encryptToken` and `DailyRankingStore`. Ours + 1 = the VS Code count in both verified cases; do not generalize from two samples.
6. **PD has no test files in the indexable set** (`test: 0`). `sampleBetaForCandidate`'s own doc comment says it is "primarily useful for tests", so its 0 references are expected for this repo — but a real repo with tests would need `--include-tests` before its reference count can be trusted.
7. **Search matching is per-token and split on `_`/`.`/camelCase**, and reports the match source. `search log` returned 10 name matches (`LOG`, `LOG_PREFIX`, …) with `truncated: true`; `search rank` returned 3 name matches with `truncated: false`, while `search ranking` also pulled in `doc` matches. Query terms are not treated as exact identifiers.
8. **Path rendering is clean on this repo.** Every reported path is repo-relative with forward slashes and no drive letter or `..`, including for the Windows absolute root — no normalization problems observed.
9. **No crashes, no unexpected tool errors, and no exit-code anomalies** across every command above; all returned `ok: true` (exit 0).
