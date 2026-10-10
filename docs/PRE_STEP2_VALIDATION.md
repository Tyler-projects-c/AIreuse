2026-10-10: section 10 records an explicit decision; section 9.4's conclusion line is superseded.

# Pre-Step-2 foundation validation

**Question.** Can the deterministic Step 1 foundation (`search_symbols`, `get_definition`,
`get_signature`, `get_references`, driven through the CLI) give a future LLM investigator
enough evidence to detect AI code reinvention? The foundation is tested **as-is**; no code
was changed to make a case pass.

**Conclusion (superseded):** §8 read **FOUNDATION READY FOR STEP 2**. §9, written after
review and after the Task 10 retrieval fixes, corrects the class labels and the
conclusion to **FOUNDATION NEEDS CHANGES BEFORE STEP 2**. The original finding is kept
above its correction rather than deleted.

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

**(a) TOOL LIMITATION** — a defect or missing capability of the four tools/index. As
written, none of these changed a case verdict, but they shape query success. *(Task 10
fixed the three marked **FIXED** below; the other two remain. See §9 for the corrections
to this section.)*

- **No body/code-identifier search.** Indexed tokens come from name, doc and signature
  only. `createCipheriv("aes-256-gcm", …)` in C3's body was not directly searchable;
  `aes`/`gcm` matched only a *file-local* const (`IV_BYTES`), not `encryptToken`.
  **Still true after Task 10, and this — not stemming — is why `search suppress` is empty
  (§9.2).**
- **Exact-token matching, no stemming/pluralization.** `search decimals` returns 0 even
  though `roundUpCents`'s doc contains "two decimal places". **FIXED in Task 10** —
  `search decimals` now returns `roundUpCents`. The second half of this bullet
  (`search suppress` returns 0 "even though the canonical's doc says 'suppressed'") was a
  **misdiagnosis**: that word is not in any indexed field, so stemming cannot reach it
  (§9.2).
- **A trailing digit is not split off a name.** `search round` matches `roundUpCents`
  (camelCase split) but **not** `round2` (token is the literal `round2`). A natural query
  ("round", "round to 2 decimals") thus misses `round2`; only the exact name or a doc token
  reaches it. **FIXED in Task 10** — `search round` now returns every `round2`. This also
  removes the mechanism by which control N3 "passed"; see §9.2 and §4 of
  [`task10/COMPARISON.md`](task10/COMPARISON.md).
- **No synonym/semantic search.** The new code's own vocabulary can miss a canonical that
  shares meaning but no tokens (the mechanism behind C3's PARTIAL). **Still true — and it
  is a class-(a) cause of C3's PARTIAL, not just a Step 2 improvement (§9.2).**
- **No way to scope or list a file.** `search_symbols` accepted only `path_prefix`
  (a plain string prefix), so there was no way to ask for all symbols of one file, and no
  way to tell "the path matched nothing" from "nothing in the path matched". "Expand within
  the canonical's file" was therefore not implementable with the four tools. **FIXED in
  Task 10** — optional `file` scope plus `file_filter_matched_files` (§9.3).

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

## 8. Overall conclusion (superseded by §9)

**FOUNDATION READY FOR STEP 2** — *superseded. This heading was demoted from a heading to
plain text so that the document ends with a single conclusion heading, and the claim below
that §9 contradicts is struck through rather than deleted.*

**Decision rule applied (fixed in advance).** READY requires YES+PARTIAL ≥ 70% of cases,
at least half of all cases YES, and every non-YES result class (b) or (c). Observed:
YES+PARTIAL = **6/7 ≈ 86%** (≥ 70% ✓), YES = **4/7 ≈ 57%** (≥ half ✓), and the non-YES
results are C3 (b), C6 (b), C7 (c) — ~~**no class (a) failure affected any case**, so nothing
blocks the evidence contract. NEEDS CHANGES does not trigger. The numbers do not fall
between thresholds, so no user decision is required on that point.~~ **This claim is wrong:
§9.2 corrects C3 to (a)+(b), and the rule then fails on its third condition (§9.4).**

**Explanation.** The four tools, as-is, surface the correct canonical in the overwhelming
majority of cases from the new code alone, and `get_definition` bodies + `get_signature`
compatibility give enough to justify "same job" whenever it surfaces (C1, C2, C4, C5 all
confirmed behaviourally). The two PARTIALs are *discovery/confirmation* shortfalls an LLM
investigator closes with better queries — not tool defects. The single NO is the
pre-declared nested-local index gap, which is expected and out of scope for Step 2.

**(Correction: read this paragraph with §9 — "not tool defects" is too generous, and
class-(b) requirement #2 below was not implementable with the four tools as they were.)**

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

---

## 9. Corrections after review (Task 10)

This section is a correction, not a rewrite: §8 above is kept verbatim as history, with
its heading demoted to plain text and the one sentence §9 contradicts struck through. The
numbers it quotes still reproduce exactly. What changes is the interpretation of the
sample and the class labels, and therefore the conclusion.

### 9.1 C3 is the only genuine vocabulary-mismatch case, and it was only PARTIAL

C3 (`protectCredential` → `encryptToken`) is the **only** case in the sample whose new
code shares no name and no vocabulary token with its canonical: it talks about
`protect`/`credential`/`vault`/`envelope` and its body uses
`createCipheriv("aes-256-gcm", …)`, while the canonical is called `encryptToken`. It
scored **PARTIAL**.

C1 and C2 are presented above as the sample's two "genuine" duplicates, but neither is a
meaningful semantic-vocabulary stress test. C1's new code is `todayUtcMidnight` and its
canonical is `utcDayStart` — the shared token `utc` is in both names — and C2's canonical
is literally named `round2`, the exact query that surfaced it. Both were answered by
typing a token the two symbols obviously share. So the sample's **4/7 YES** rate measures
how well *exact name-token* search handles duplicates whose names overlap, and the two
"genuine" cases demonstrate no hard-case retrieval at all. Where the vocabulary genuinely
diverged (C3), the foundation reached only PARTIAL. **The YES count therefore overstates
how well name-token search handles different-vocabulary duplicates.**

### 9.2 The earlier class labeling is corrected, not rationalized

§8's claim that **no class (a) failure affected any case** is **wrong**.

- **Missing synonym/body search contributed to C3**, so C3 is **(a) + (b)**, not (b)
alone. The canonical's indexed tokens include `encrypt`/`decrypt`/`token` (its name, doc
and signature); the new code's are `protect`/`credential`/`vault`/`envelope`, and the
only bridge the investigator found (`encrypt`, rank 1, on the 7th of 8 calls) is a
synonym of the new code's *behaviour* rather than of its words. Only a synonym or body hit
could bridge that, and both are tool capabilities, not query choices.
- **The missing stemming and the un-split trailing digit degraded C2, C4 and N3**, even
where no verdict changed: C2's natural query `round` could not reach `round2` at all
(1 result, canonical absent); C4's canonical sat at rank 7, i.e. outside the default
5-result response, and `search alerts` returned a single unrelated symbol where it now
returns the canonical at rank 4; and control N3 "passed" only because `roundUpCents`
could not reach `round2` either. §5a listed these
under "(a) TOOL LIMITATION … none of these changed a case verdict"; Task 10 fixed all
three, and N3's control property **did** change as a direct result (see §4 of
[`task10/COMPARISON.md`](task10/COMPARISON.md)).
- §5a's second attribution — `search suppress` returns 0 because of "exact-token matching,
no stemming" — was also wrong. "suppressed" appears only in the module JSDoc's later
paragraphs, in interface **member** names/types (members are not indexed symbols) and in
the function body; `doc_summary` is the first sentence only. Task 10 added stemming and
`search suppress` **still** returns 0: the cause is the class-(a) **no-body-search** gap.

### 9.3 The missing file scope made class-(b) requirement #2 unimplementable

§8's class-(b) requirement #2 asks Step 2 to "follow the file-sibling breadcrumb" and
"treat sibling-file hits as candidate seeds and expand within the file". With the four
tools as they were, that was not implementable: `search_symbols` had no file or path
scope (`path_prefix` is a raw string prefix, which cannot express "this file" or "this
directory and nothing that merely shares its name"), there was no way to enumerate a
file's symbols, and no way to distinguish a path that matched nothing from a term that
matched nothing.

**Task 10's `file` scope directly addresses that gap**: an optional segment-boundary path
filter plus `file_filter_matched_files`, and — with `file` present — a termless listing
mode that returns a scope's symbols in deterministic (file, line) order. "Expand within
the canonical's file" is now a single call. Requirement #2 is no longer blocked by the
toolset.

### 9.4 Re-applying the original fixed decision rule

The rule is unchanged and is applied here to the **corrected** labels and to the
post-Task-10 replay ([`task10/COMPARISON.md`](task10/COMPARISON.md), 33 frozen queries,
same root, same canonicals, no verdict upgraded for a longer result list):

| condition | requirement | observed | result |
|---|---|---|---|
| (i) | YES+PARTIAL ≥ 70% of cases | 6/7 ≈ 86% | **pass** |
| (ii) | at least half of all cases YES | 4/7 ≈ 57% | **pass** |
| (iii) | every non-YES result class (b) or (c) | C3 **(a)+(b)**, C6 (b), C7 (c) | **fail** |

Task 10 moved no verdict (before YES 4 / PARTIAL 2 / NO 1 → after YES 4 / PARTIAL 2 /
NO 1), caused no regression, and kept recall monotonic; it closed three class-(a)
retrieval gaps (letter/digit token splitting, light stemming, file scope). It did not
close the class-(a) gap behind the failure above, because body-text and semantic search
are explicitly out of scope for it.

~~The observed numbers do not fall *between* thresholds — conditions (i) and (ii) both pass
comfortably — the rule fails on its third condition, and it does so because the earlier
labeling was too generous, not because anything regressed.~~ superseded by section 10

The one judgement call left to you: whether "no body-text/synonym retrieval in the Step 1
foundation" is an accepted boundary or a Step 2 blocker. Every case either surfaces its
canonical or has a named, understood reason; only the class-(a) component of C3 (and demo
D5 in the comparison) stands between the current state and a READY verdict under the rule
as originally fixed.

**Mechanical output of section 9.4 (superseded by section 10): FOUNDATION NEEDS CHANGES BEFORE STEP 2**

## 10. Decision record (2026-10-10)

Evidence
- Original cases (unchanged by Task 10): YES 4 / PARTIAL 2 / NO 1; conditions (i) 86% and (ii) 57% pass; condition (iii) fails only because C3 is class (a)+(b).
- Rule status: READY not met (condition iii). NEEDS CHANGES not triggered: the class (a) failure affects one case (C3), and it does not block the evidence contract (C3 was reached at rank 1 with the query `encrypt`, and def/sig/refs then supplied the evidence). The outcome is in the rule's gap and is therefore an explicit judgement, not a rule output.
- Task 10 closed three fixable class (a) gaps: digit splitting, light stemming, file scope. Task 10b closed pagination, so a file with more than 10 symbols can now be fully enumerated. Verified: tsc clean, vitest 158 passed, commit 33bed57.
- Remaining class (a) gap: no body-text or synonym retrieval (C3; demo D5: `search suppress` returns nothing). Remaining class (c) gap: nested/local declarations are unindexed (C7).

Decision
PROCEED TO STEP 2. The Step 1 foundation is accepted as ready with a documented boundary: no body-text/synonym retrieval and no nested-symbol indexing. This is a judgement call, not a result of the decision rule, and the rule text is unchanged.

Reasoning
- Synonym bridging is by design the investigator's job (LLM query expansion); C3 was reachable through such a query.
- Body text is the stronger gap, because AI-written duplicates often have no docs and differing names. It is therefore the first Step 2 experiment, not deferred: an optional body-token index (identifiers, callee names, imported modules), off by default, evaluated on blind cases.

Pre-registered conditions (fixed now, before the experiment)
- Evaluation set: at least 4 NEW different-vocabulary cases written blind (not by the agent that wrote the original planted cases, and not tuned against the index), plus the existing negative controls.
- Success: the body index raises the number of blind cases reaching YES by at least 2 versus the Task 10 index, and adds no negative-control failure, and never lowers a canonical's rank on the original 33 queries.
- If it does not meet this, the boundary stays and the investigator is evaluated with query expansion only.

What would reverse this decision
- The control experiment (Part 2) showing agents reliably reuse existing code under the plain prompt: the product premise is then in question and retrieval work stops until that is understood.
- The blind-case results showing the tools cannot give the investigator evidence even with body tokens.
