# Pre-Step-2 foundation validation

**Question.** Can the deterministic Step 1 foundation (`search_symbols`, `get_definition`,
`get_signature`, `get_references`, driven through the CLI) give a future LLM investigator
enough evidence to detect AI code reinvention? The foundation is tested **as-is**; no code
was changed to make a case pass.

**Conclusion: FOUNDATION READY FOR STEP 2** (see §8).

---

## 1. Method

- **Target repo.** `PD` (Shopify + React Router monorepo), HEAD
  `00d93d9780f6800dd757a17f6412ab150b0bf2a7`. PD's own working tree was left untouched
  (it already carried unrelated pre-existing changes — `M shopify.app.toml`,
  `?? REVIEW.diff` — none made by this validation).
- **Scratch worktree.** Planted cases live only in a git worktree of PD at `../PD-scratch`
  on branch `scratch/reinvention-validation` (commit `07bcc65`), created outside PD's
  working tree and **never pushed**. All indexing/queries used `--root ../PD-scratch`.
- **Call budget.** At most **8 CLI invocations** (search/def/sig/refs) per case.
- **Query discipline.** For each case the investigator saw *only* the suspected (new)
  implementation — its name, signature, body and location — and formed queries from its
  name, doc, string literals, called functions and behavior keywords. The canonical
  implementation's name/file was **never** used to form a query. The canonical source was
  only inspected after it surfaced (or after the budget was spent), to judge sufficiency.
- **Verdict definitions (fixed in advance).**
  - **YES** — canonical surfaced within budget **and** def/sig/refs together gave enough
    evidence to justify "these do the same job".
  - **PARTIAL** — surfaced, but ranked outside the top 10, or only via a query the
    investigator would have had to guess, or with insufficient evidence.
  - **NO** — never surfaced within budget. If unsure, the lower verdict was chosen.
- **Cause classes.** (a) TOOL LIMITATION — a defect/missing capability in the four tools
  or the index; (b) NEEDS STEP 2 — fixed by candidate generation or an LLM choosing better
  queries; (c) INDEX COVERAGE GAP — e.g. nested/local declarations, denied files.
- **Sample.** 7 cases (2 genuine duplicates already in PD, 5 planted) + 3 negative controls.

## 2. Case table

| # | New / suspected impl | Canonical impl | Query that surfaced canonical | Verdict | Cause |
|---|---|---|---|---|---|
| 1 | `app/utils/product-sync.server.ts:433` `todayUtcMidnight` (genuine) | `app/utils/product-surface-stats.server.ts:212` `utcDayStart` | Q1 `search todayUtcMidnight` → rank 2 | **YES** | — |
| 2 | `app/utils/product-surface-stats.server.ts:66` `round2` (genuine) | `app/utils/order-verification.server.ts:79` `round2` | Q1 `search round2` → rank 2 (also `attribution` `round2` rank 1) | **YES** | — |
| 3 | `app/utils/credential-vault.server.ts:26` `protectCredential` (planted) | `app/utils/crypto.server.ts:42` `encryptToken` | only Q7 `search encrypt` → rank 1 | **PARTIAL** | **b** |
| 4 | `app/utils/alert-dedupe.server.ts:15` `throttleAlerts` (planted) | `app/utils/alert-throttle.server.ts:45` `shouldAlertToSentry` | Q2 `search alert` → rank 3 | **YES** | — |
| 5 | `app/utils/revenue-view.ts:9` `preferredRevenue` (planted) | `app/utils/verified-revenue.ts:39` `effectiveRevenue` | Q1 `search preferredRevenue` → rank 4 | **YES** | — |
| 6 | `app/utils/purchase-window.ts:8/10` `PURCHASE_WINDOW_DAYS` / `isWithinPurchaseWindow` (planted) | `app/utils/attribution.server.ts:91` `DEFAULT_WINDOW_DAYS` | Q3 `search window` → rank 1 | **PARTIAL** | **b** |
| 7 | `app/utils/format.ts:5` `asPercent` (planted) | `app/utils/insights.ts:9` nested `formatRatio` inside `summarizeConversion` | none | **NO** | **c** |

Totals: **YES 4, PARTIAL 2, NO 1** (7 cases). Required shapes covered: 3 clearly
different-name cases (3, 4, 6), 1 broader variant (5), 1 nested-local canonical (7),
2 genuine PD duplicates (1, 2).

## 3. Per-case detail

**C1 — `todayUtcMidnight` → `utcDayStart` (genuine, different names).**
`todayUtcMidnight(): Date` returns today's UTC midnight; `utcDayStart(date?: Date): Date`
does the same with an optional date. Calls: Q1 `todayUtcMidnight` (5 results,
`utcDayStart` **rank 2** — the shared token `utc` matches), Q2 `utc day` (rank 1),
Q3 `midnight` (2 results, canonical absent), Q4 `day start` (rank 1); then Q5 `def s_193`,
Q6 `def s_171`, Q7 `sig s_193 --compare-to s_171`. Both bodies return a UTC-midnight
`Date`; sig compat `same_param_count=false, params_assignable=true, return_assignable=true`.
**YES.**

**C2 — `round2` → `round2` (genuine, same name).** Q1 `search round2` (3 results:
`attribution` rank 1, `order-verification` **rank 2**, `product-surface-stats` rank 3);
Q2 `search round` (1 result, did not include `round2` — see §5a); Q3 `def s_141`,
Q4 `sig s_169 --compare-to s_141` (all four compat fields true). Bodies byte-identical.
**YES.**

**C3 — `protectCredential` → `encryptToken` (planted, different name).** Doc/vocabulary
terms are `protect / credential / vault / envelope`; the body uses
`createCipheriv("aes-256-gcm", …)`. Q1 `protectCredential`, Q2 `credential`,
Q3 `credential vault`, Q4 `envelope` → **none** surfaced the canonical (Q4 returned only a
file-local `VERSION` const). Q5 `aes`, Q6 `gcm` → only `IV_BYTES` (a const in
`crypto.server.ts`) surfaced, not `encryptToken`. Q7 `encrypt` → `encryptToken` **rank 1**,
`decryptToken` rank 2. Budget exhausted (8/8). The canonical is real and correct, but the
new code never uses the word "encrypt"; the investigator must bridge algorithm→synonym.
**PARTIAL, cause (b)** — an LLM choosing synonym/algorithm queries finds it immediately.

**C4 — `throttleAlerts` → `shouldAlertToSentry` (planted, different name).** Q1
`throttleAlerts` surfaced sibling symbols from the canonical's *file* (`ThrottleEntry`,
`ThrottleDecision`, `__resetAlertThrottleForTests`) but not the function itself; Q2
`alert` → `shouldAlertToSentry` **rank 3**; Q3 `dedupe`, Q4 `suppress` → none; Q5
`def s_87`, Q6 `def s_91`, Q7 `sig --compare-to`. Both 18-line bodies implement the same
first-occurrence-alerts / repeats-counted-window policy; compat
`same_param_count=true, params_assignable=true, return_assignable=false` (return type name
differs). **YES.**

**C5 — `preferredRevenue` → `effectiveRevenue` (planted, broader variant).** Q1
`preferredRevenue` → `effectiveRevenue` **rank 4**; Q2 `revenue` → rank 4; Q3 `def s_197`,
Q4 `def s_244`, Q5 `sig --compare-to` (`same_param_count=false` — extra `strict` option,
`params_assignable=false`, `return_assignable=true`). Bodies show the same preferred/fallback
logic with an extra flag. **YES.**

**C6 — `PURCHASE_WINDOW_DAYS` / `isWithinPurchaseWindow` → `DEFAULT_WINDOW_DAYS` (planted, different name).**
Q1 `isWithinPurchaseWindow` → `DEFAULT_WINDOW_DAYS` **rank 3**; Q2 `purchase window` →
rank 3 (+ `DEFAULT_CONVERSION_WINDOW_DAYS` rank 4); Q3 `window` → **rank 1**; Q4 `def s_99`,
Q5 `def s_233`, Q6 `def s_196`. The canonical surfaced and the value matches (`14`), but the
canonical is a **bare constant** — `get_definition` returns only
`const DEFAULT_WINDOW_DAYS = 14`, with no function body to compare against the new
temporal-window logic. Evidence for the *constant* is name+value; behavioral equivalence of
the re-implemented window check can only be confirmed by opening `computeAttribution`.
**PARTIAL, cause (b)** — confirmation, not discovery, is what an LLM adds here.

**C7 — `asPercent` → nested `formatRatio` (planted, nested-local canonical).** The
canonical is `formatRatio`, declared **inside** `summarizeConversion`
(`app/utils/insights.ts:9`). Q1 `asPercent`, Q2 `percent`, Q3 `ratio`, Q4 `format ratio`,
Q5 `conversion summary`. `formatRatio` never appears in any result — it is not an indexed
symbol (confirmed: `summarizeConversion` is indexed, `formatRatio` is not). Q5 surfaced
`summarizeConversion` itself, but that query is not derivable from `asPercent`'s
vocabulary, so the nested canonical is unreachable from the new code. **NO, cause (c)** —
this is the pre-declared known gap; it is expected and not a Step 2 blocker.

## 4. Negative controls

| # | Suspected (new) | Superficially similar existing | Tools surfaced the similar? | Evidence distinguishes? |
|---|---|---|---|---|
| N1 | `utcDateString` (`thompson-daily-cache.ts:39`) → `"YYYY-MM-DD"` string | `utcDayStart` (`product-surface-stats.server.ts:212`) → `Date` | yes — rank 2 (`utcDateString`), rank 1 (`utc`) | **yes** — bodies differ (format vs setUTCHours) |
| N2 | `idFromGid` (`product-sync.server.ts:65`) → parses trailing digits of a GID | `lineProductId` (`order-verification.server.ts:84`) → validates a numeric field | yes — rank 2 (`idFromGid`), rank 1 (`product id`) | **yes** — bodies differ (regex on string vs field validation) |
| N3 | `roundUpCents` (`money-util.ts:2`) → `Math.ceil` to 2dp | `round2` → `Math.round` to 2dp | **no** — `round2` did not surface from `roundUpCents`/`cents` | yes via `def` bodies (`ceil` vs `round`) |

All three controls **pass**: the tools neither raised a false "same job" for N1/N2 (their
bodies are visibly different), nor surfaced the superficially-similar `round2` for N3 —
though N3 means an investigator must independently know `round2` exists (see §5). Note the
risk this surfaces: because `get_definition` does return the body, a false positive is
avoidable when both symbols surface; it is not avoidable from name/signature alone.

## 5. Retrieval limitations discovered (grouped by cause class)

**(a) TOOL LIMITATION** — a defect or missing capability of the four tools/index. None of
these changed a case verdict, but they shape query success:

- **No body/code-identifier search.** Indexed tokens come from name, doc and signature
  only. `createCipheriv("aes-256-gcm", …)` in C3's body was not directly searchable;
  `aes`/`gcm` matched only a *file-local* const (`IV_BYTES`), not `encryptToken`.
- **Exact-token matching, no stemming/pluralization.** `search decimals` returns 0 even
  though `roundUpCents`'s doc contains "two decimal places"; `search suppress` returns 0
  even though the canonical's doc says "suppressed".
- **A trailing digit is not split off a name.** `search round` matches `roundUpCents`
  (camelCase split) but **not** `round2` (token is the literal `round2`). A natural query
  ("round", "round to 2 decimals") thus misses `round2`; only the exact name or a doc token
  reaches it.
- **No synonym/semantic search.** The new code's own vocabulary can miss a canonical that
  shares meaning but no tokens (the mechanism behind C3's PARTIAL).

**(b) NEEDS STEP 2** — resolvable by candidate generation or by an LLM forming better
queries (not a tool defect):

- C3: bridging behavior/algorithm vocabulary to the canonical's word ("encrypt").
- C6: confirming equivalence when the reuse target is a bare constant and the re-used
  logic is inline elsewhere — the LLM must open the containing module.
- General: on near-miss queries the canonical's *file siblings* often surface while the
  exact function does not (C4 `throttleAlerts` → sibling types/consts; C3 `aes` →
  `IV_BYTES`). Sibling-file hits are a strong breadcrumb an LLM can follow, but the raw
  ranking alone does not hand over the function.

**(c) INDEX COVERAGE GAP** — a capability the index lacks by design:

- **Nested/local declarations are not indexed.** C7's canonical (`formatRatio` inside
  `summarizeConversion`) is unreachable; corroborated by real PD (`const enableTracking`
  inside component `Index` in `app/routes/app._index.tsx`). Unreachable from the new code
  by construction — expected, and not a Step 2 blocker.

## 6. Control experiment (Part 2)

**Status: NOT RUN.**

The contamination rule forbids playing the coding agent in this session, so Part 2 requires
a **fresh independent session per run**. That could not be launched here, so results were
**not** simulated. Exact method check: no subagent/session-launch tool is available
in-session; among installed CLIs, `claude`, `codex`, `aider` and `cursor-agent` are **not
found**, and while `gemini` and `opencode` (1.14.30) are present, `opencode run "<trivial
prompt>"` produced no output and hit the timeout (exit 124) — it is not usable
non-interactively without further setup/credentials.

Harness to run the experiment: [`docs/control-experiment-prompts.md`](docs/control-experiment-prompts.md)
— 6 behavior-only task prompts (each targeting one canonical above), the exact Condition-A
and Condition-B text, the run protocol (fresh session, clean checkout at the base commit
`00d93d9`, save the diff), and the REUSED/REINVENTED/MIXED rubric.

## 7. Small-sample caveat

This is a **sanity check, not a benchmark**: 7 hand-chosen cases (2 genuine, 5 planted) and
3 controls in a single repo, with verdicts assigned by following a fixed protocol. It is
enough to detect a blocking tool defect and to separate tool gaps from Step 2 work; it is
not a statistically meaningful estimate of real-world retrieval rates. Part 2 is not run.

## 8. Overall conclusion

# FOUNDATION READY FOR STEP 2

**Decision rule applied (fixed in advance).** READY requires YES+PARTIAL ≥ 70% of cases,
at least half of all cases YES, and every non-YES result class (b) or (c). Observed:
YES+PARTIAL = **6/7 ≈ 86%** (≥ 70% ✓), YES = **4/7 ≈ 57%** (≥ half ✓), and the non-YES
results are C3 (b), C6 (b), C7 (c) — **no class (a) failure affected any case**, so nothing
blocks the evidence contract. NEEDS CHANGES does not trigger. The numbers do not fall
between thresholds, so no user decision is required on that point.

**Explanation.** The four tools, as-is, surface the correct canonical in the overwhelming
majority of cases from the new code alone, and `get_definition` bodies + `get_signature`
compatibility give enough to justify "same job" whenever it surfaces (C1, C2, C4, C5 all
confirmed behaviourally). The two PARTIALs are *discovery/confirmation* shortfalls an LLM
investigator closes with better queries — not tool defects. The single NO is the
pre-declared nested-local index gap, which is expected and out of scope for Step 2.

**Class (b) findings — Step 2 requirements, not failures:**

1. **Synonym/behavior→vocabulary query expansion.** When the new code describes behaviour
   without the canonical's keywords (C3: "protect/credential" vs "encrypt"), the
   investigator should widen to algorithm/synonym terms. Candidate generation or an
   LLM-query step must provide this.
2. **Follow the file-sibling breadcrumb.** Queries frequently surface a canonical's *file
   siblings* (C4 `throttleAlerts` → `alert-throttle.server.ts` types; C3 `aes` →
   `IV_BYTES`) rather than the symbol. Step 2 should treat sibling-file hits as candidate
   seeds and expand within the file.
3. **Handle constant/inline reuse targets.** When the reuse target is a bare constant (C6
   `DEFAULT_WINDOW_DAYS`) or logic that is inline rather than extracted, the investigator
   must open the containing module to confirm equivalence; the evidence contract should
   require a body/inline check rather than a value match alone.

**Class (c) — known gap to document (not a Step 2 blocker):** nested/local declarations
(C7) are unindexed; reinventions of component-local helpers cannot be detected by the
current index.
