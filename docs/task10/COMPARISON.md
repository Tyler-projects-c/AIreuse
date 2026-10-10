# Task 10 — retrieval comparison (before / after)

Same 7 cases (C1–C7) and 3 negative controls (N1–N3) as
[`../PRE_STEP2_VALIDATION.md`](../PRE_STEP2_VALIDATION.md), replayed over the
same index root after the three Task 10 retrieval fixes. No query, no canonical
and no index root changed between the two runs.

## 0. Harness

| item | value |
|---|---|
| Index root | `../PD-scratch` (PD worktree, branch `scratch/reinvention-validation`, commit `07bcc65`, tree clean) |
| Driver | [`scripts/replay.ts`](../../scripts/replay.ts) → `run()` from `src/cli.ts`, i.e. the real CLI |
| Flags | `search <term> --json --root ../PD-scratch --limit 10` (tests hidden, as in the original run) |
| Queries | the 33 frozen entries in [`queries.json`](queries.json), recovered verbatim from the original report's §3/§4 — every one was recoverable, so none is marked "unrecoverable" and none was excluded. C1–C7's search terms come from §3's per-case `Q1..Qn` list; N1–N3's come from §4's parenthetical annotations (`utcDateString`, `utc`; `idFromGid`, `product id`; `roundUpCents`, `cents`). No query was reworded, invented or added |
| Rank | 1-based position of the case's canonical symbol, matched by **name + file**; canonicals are never used to form a query |
| Before | [`before.json`](before.json) (pre-Task-10 code, HEAD `2ae9626`) |
| After | [`after.json`](after.json) (HEAD `ec47f2a`, the three Task 10 commits) |

`--limit 10` (the maximum) rather than the default 5 is used because several
canonicals sit between rank 6 and 10; the original report's own ranks reproduce
exactly at this limit (C1 2/1/–/1, C2 2, C3 1 on `encrypt`, C4 3, C5 4, C6 3/3/1,
N1 2/1, N2 2/1, N3 none), so the before column is the same measurement as the
original, only less truncated.

## 1. Per query

| case | qid | query | before (rank/total) | after (rank/total) | Δrank | Δtotal |
|---|---|---|---|---|---|---|
| C1 | Q1 | `todayUtcMidnight` | 2/9 | 2/9 | same | 0 |
| C1 | Q2 | `utc day` | 1/10 | 1/10 | same | 0 |
| C1 | Q3 | `midnight` | —/2 | —/2 | none | 0 |
| C1 | Q4 | `day start` | 1/9 | 1/10 | same | +1 |
| C2 | Q1 | `round2` | 2/3 | 2/5 | same | +2 |
| C2 | Q2 | `round` | —/1 | 3/5 | **new** | +4 |
| C3 | Q1 | `protectCredential` | —/2 | —/3 | none | +1 |
| C3 | Q2 | `credential` | —/2 | —/3 | none | +1 |
| C3 | Q3 | `credential vault` | —/2 | —/3 | none | +1 |
| C3 | Q4 | `envelope` | —/1 | —/1 | none | 0 |
| C3 | Q5 | `aes` | —/1 | —/1 | none | 0 |
| C3 | Q6 | `gcm` | —/1 | —/1 | none | 0 |
| C3 | Q7 | `encrypt` | 1/2 | 1/2 | same | 0 |
| C4 | Q1 | `throttleAlerts` | 7/7 | 6/9 | up 1 | +2 |
| C4 | Q2 | `alert` | 3/6 | 3/7 | same | +1 |
| C4 | Q3 | `dedupe` | —/0 | —/0 | none | 0 |
| C4 | Q4 | `suppress` | —/0 | —/0 | none | 0 |
| C5 | Q1 | `preferredRevenue` | 4/7 | 4/7 | same | 0 |
| C5 | Q2 | `revenue` | 4/7 | 4/7 | same | 0 |
| C6 | Q1 | `isWithinPurchaseWindow` | 3/10 | 3/10 | same | 0 |
| C6 | Q2 | `purchase window` | 3/10 | 3/10 | same | 0 |
| C6 | Q3 | `window` | 1/10 | 1/10 | same | 0 |
| C7 | Q1 | `asPercent` | —/2 | —/2 | none | 0 |
| C7 | Q2 | `percent` | —/1 | —/1 | none | 0 |
| C7 | Q3 | `ratio` | —/2 | —/2 | none | 0 |
| C7 | Q4 | `format ratio` | —/2 | —/2 | none | 0 |
| C7 | Q5 | `conversion summary` | —/3 | —/5 | none | +2 |
| N1 | Q1 | `utcDateString` | 2/10 | 2/10 | same | 0 |
| N1 | Q2 | `utc` | 1/9 | 1/9 | same | 0 |
| N2 | Q1 | `idFromGid` | 2/10 | 2/10 | same | 0 |
| N2 | Q2 | `product id` | 1/10 | 1/10 | same | 0 |
| N3 | Q1 | `roundUpCents` | —/1 | 4/5 | **new** | +4 |
| N3 | Q2 | `cents` | —/1 | —/2 | none | +1 |

**Recall is monotonic.** No query returned fewer results than before, and no
canonical lost rank or disappeared: `Δtotal ≥ 0` everywhere and `Δrank` contains
no `down`. That is by construction — the tokenizer keeps every token it used to
produce and only adds whole-identifier, letter/digit and stem tokens, and a
stem-only match is weighted strictly below an exact match. Caveat: eight queries
already sit at the 10-result cap before *and* after, so for those the row cannot
show growth even if it occurred; the canonical's rank in those rows is unchanged.

## 2. Per case: improved / unchanged / regressed

| case | verdict | reason |
|---|---|---|
| C1 | **unchanged** | Canonical already at best rank 1 (`utc day`, `day start`) and rank 2 (`todayUtcMidnight`). Only movement is `day start` 9→10 results: one extra stem-only hit slotted in below the exact hits. |
| C2 | **improved (discovery only)** | `search round` returned a single result before and did not include any `round2`; it now returns 5 with this case's `round2` at rank 3. The exact `round2` query is unchanged (rank 2, two extra stem hits below it). The verdict was already YES via the exact name, so this changes the *path*, not the verdict. |
| C3 | **unchanged** | Six of seven queries still surface nothing relevant; the canonical is still reachable only through the algorithm word `encrypt` (rank 1). Each of `protectCredential`/`credential`/`credential vault` gained exactly one extra result (a stem hit) without moving the canonical into view. The blocker is vocabulary bridging plus the absence of body/synonym search, which Task 10 deliberately does not address. |
| C4 | **improved (marginally)** | `throttleAlerts` moved the canonical 7→6, i.e. it is now visible inside a 10-result response where before it was only visible if the caller raised the limit. `alert` is stable at rank 3. `dedupe` and `suppress` are still 0 results. |
| C5 | **unchanged** | Ranks and result lists identical. |
| C6 | **unchanged** | Ranks identical (`window` 1, others 3). |
| C7 | **unchanged (never surfaced)** | `formatRatio` is a nested local and is still not an indexed symbol, so every rank is `—` before and after. `conversion summary` grew 3→5 results, all irrelevant. Class (c). |
| N1 | **unchanged (control passes)** | `utcDayStart` still surfaces at rank 2/1 and its body still differs from `utcDateString`. |
| N2 | **unchanged (control passes)** | `lineProductId` still surfaces at rank 2/1 and its body still differs from `idFromGid`. |
| N3 | **CHANGED — control property lost** | `search roundUpCents` now surfaces `round2` at rank 4 (and `cents` gained one result). The original control passed only because the tokenizer could not split the trailing digit off `round2` — a tokenizer *gap*, not evidence of retrieval quality. This is the control behaving differently, not a case regression. The control's real purpose still holds: the two bodies (`Math.ceil((amount - Number.EPSILON) * 100) / 100` vs `Math.round(n * 100) / 100`) are visibly different via `def`, so no false "same job" is raised. |

**Regressions: none.** No canonical was pushed down by a new stem match, and no
result list shrank. The only adverse change is to a *negative control* (N3),
described above, whose "not surfaced" property was an artifact of the very gap
Task 10 removes.

## 3. Old vs new verdicts

Verdicts use the **original** definitions from `../PRE_STEP2_VALIDATION.md` §1
unchanged, and the original 8-CLI-call budget. A larger result list does not
upgrade a verdict.

| # | case | before | after | notes |
|---|---|---|---|---|
| C1 | `todayUtcMidnight` → `utcDayStart` | YES | YES | unchanged; see the §9 correction — this is a token-overlap case, not a vocabulary stress test |
| C2 | `round2` → `round2` | YES | YES | unchanged; the `round`-query path is now open as well |
| C3 | `protectCredential` → `encryptToken` | PARTIAL | PARTIAL | unchanged. Still surfaced only by `encrypt` (rank 1) after 7 of the 8 calls. Corrected cause: **(a) + (b)**, not (b) alone |
| C4 | `throttleAlerts` → `shouldAlertToSentry` | YES | YES | unchanged (`alert`, rank 3) |
| C5 | `preferredRevenue` → `effectiveRevenue` | YES | YES | unchanged (rank 4) |
| C6 | `PURCHASE_WINDOW_DAYS` → `DEFAULT_WINDOW_DAYS` | PARTIAL | PARTIAL | unchanged: the target is a bare constant, so behavioural equivalence still needs the containing module. Not upgraded — the original definition asks for evidence sufficiency, and the original run's PARTIAL reason is confirmation, which an LLM supplies. (The new `--file` scope is the mechanism that makes that confirmation step implementable; see the demos.) |
| C7 | `asPercent` → nested `formatRatio` | NO | NO | unchanged: nested-local canonical, still unindexed |
| | **totals** | **YES 4 / PARTIAL 2 / NO 1** | **YES 4 / PARTIAL 2 / NO 1** | no verdict moved |

Why nothing moved: the three fixes removed three *retrieval artifacts* (the
missing `round`→`round2` path, one rank position in C4, and the N3 false
negative) but none of them was the decisive factor in a verdict. C3's blocker is
vocabulary/synonym discovery, C6's is confirmation against a constant, C7's is
index coverage.

## 4. Capability demos (not counted toward any verdict)

All commands were run against `../PD-scratch`. "Before" numbers were re-measured
by running the same CLI from the pre-Task-10 `src/` (HEAD `2ae9626`).

**D1 — a trailing-digit name is reachable from its stem-free part** (fixes §5a).

```
$ search round --limit 5            # before: exactly ONE result, roundUpCents
s_134  function  roundUpCents   app/utils/money-util.ts:2
s_97   function  round2         app/utils/attribution.server.ts:81
s_141  function  round2         app/utils/order-verification.server.ts:79     <- C2's canonical
s_169  function  round2         app/utils/product-surface-stats.server.ts:66
s_137  const     VERIFICATION_ROUNDING_THRESHOLD  app/utils/order-verification.server.ts:61
```

**D2 — a plural query reaches a singular doc token** (fixes the documented
`search decimals` → 0 limitation).

```
$ search decimals --limit 5         # before: "(no results)"
s_17   function  toDecimal       app/routes/api.events.tsx:144
s_123  function  asPercent       app/utils/format.ts:5
s_134  function  roundUpCents    app/utils/money-util.ts:2                    <- N3's suspected symbol
s_243  function  toNumberOrNull  app/utils/verified-revenue.ts:29
```

`roundUpCents`'s doc_summary says "two decimal place**s**" and `asPercent`'s says
"one-decimal"; both were unreachable from the query `decimals` before, and both
are doc-stem hits now.

**D3 — a plural query reaches an alerting symbol by stem** (fixes §5a's
"`alert` misses `alerts`").

```
$ search alerts --limit 5           # before: exactly ONE result, throttleAlerts
s_87   function  throttleAlerts         app/utils/alert-dedupe.server.ts:15
s_23   const     PROXY_HMAC_ALERT_KEY   app/routes/api.proxy.$.tsx:68
s_24   const     PROXY_HMAC_ALERT_WINDOW_MS  app/routes/api.proxy.$.tsx:69
s_91   function  shouldAlertToSentry    app/utils/alert-throttle.server.ts:45  <- C4's canonical
s_92   function  __resetAlertThrottleForTests  app/utils/alert-throttle.server.ts:65
```

**D4 — expand within the canonical's file** (`--file`, the capability that made
class-(b) requirement #2 unimplementable with the four tools).

```
$ search --file app/utils/crypto.server.ts      # no term: list the file's symbols
s_110  const     IV_BYTES        app/utils/crypto.server.ts:20
s_111  const     AUTH_TAG_BYTES  app/utils/crypto.server.ts:21
s_112  const     KEY_BYTES       app/utils/crypto.server.ts:22
s_113  const     SEPARATOR       app/utils/crypto.server.ts:23
s_114  function  getKey          app/utils/crypto.server.ts:25
(file filter: 1 indexed file(s) in scope)
(truncated)
```

The scope also disambiguates "the path matched nothing" from "nothing in the
path matched":

| `--file` | `file_filter_matched_files` | results for `token` |
|---|---|---|
| `app/utils` | 23 | 3 |
| `app/utils/crypto.server.ts` | 1 | 3 |
| `app/nope` | 0 | 0 |

`app/utils` reports 23 indexed files in scope even though only 3 results come
back, because `file_filter_matched_files` counts files, not matches, and ignores
`kind`/`include_tests` — that is precisely the signal that separates "the path
matched nothing" from "nothing in the path matched".

**D5 — the one demo that does NOT work, reported honestly.** The task suggested
`search suppress` should find the symbol whose doc says "suppressed". It does
not, and it cannot: `shouldAlertToSentry`'s `doc_summary` is only the *first
sentence* of its JSDoc ("In-process alert throttle for HIGH-VOLUME rejection
paths."); the word "suppressed" occurs in the module JSDoc's later paragraphs
(lines 12–13), in interface **member** names/types (lines 28, 36–37 — interface
members are not indexed symbols), and in the function body. None of those are
indexed, and body-text search is explicitly out of scope for Task 10.

```
$ search suppress      # before: (no results)   after: (no results)
```

So the original report's §5a attribution — "`search suppress` returns 0 … no
stemming" — was **wrong**, and Task 10 proves it: with stemming in place the
query still returns 0. The real cause is the class-(a) no-body-search gap. This
is corrected in `../PRE_STEP2_VALIDATION.md` §9.

## 5. Limitations that remain after Task 10

1. **No body/synonym search.** Unchanged and out of scope (explicit constraint).
   This is what keeps C3 at PARTIAL and makes D5 impossible.
2. **Nested/local declarations are not indexed.** C7 stays NO (class c).
3. **Over-conflation is possible** (`news`→`new`, `cases`→`cas`, `value`→`valu`).
   Accepted: the rule is identical on both sides and exact matches outrank stems.
   The fixed table in [`test/text.test.ts`](../../test/text.test.ts) pins it.
4. **`--file` does no extension guessing and supports no globs**: a value that
   names neither an indexed file nor a directory prefix is simply empty scope
   (`--file app/index` matches nothing; `--file app/index.ts` matches the file).
5. **Stemming cannot retrieve what is not indexed** (see D5); it only bridges
   morphological variants of tokens that already exist in names, docs or
   signatures.

## 6. Changed existing test

Exactly one pre-existing test had to change, because its expectation was an
artifact of exact-token matching that stemming intentionally removes:

- [`test/search.test.ts`](../../test/search.test.ts) → `search_symbols > reports the
  highest contributing source as match`. It asserted
  `search_symbols({ query: "formats" })` returns exactly `["toIso"]`. `formats` now stems to
  `format`, which `exportCsv`'s doc holds literally ("Exports rows to CSV format."), so the
  result is `["toIso", "exportCsv"]`. The test's intent is preserved — the top hit and its
  `match` source are still asserted, and the new stem-only hit is asserted to rank *below*
  the exact hit.

No other pre-existing test's assertions were touched, weakened or deleted; no
assertion was relaxed to make a failure go away. The remaining 114 pre-existing
tests pass unmodified.
