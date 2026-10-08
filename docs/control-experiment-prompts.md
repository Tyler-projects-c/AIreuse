# Control experiment harness — Part 2 (Status: NOT RUN)

**Goal.** Test whether a plain "search the repo for reusable code first" instruction
already prevents reinvention, using the same canonical implementations probed in
`docs/PRE_STEP2_VALIDATION.md`.

**Status: NOT RUN.** A fresh, independent agent session could not be launched from
within this validation session (see `docs/PRE_STEP2_VALIDATION.md` §6 for the exact
method check). Per the task rules the results are *not* simulated. Run the sessions
below and send back the diffs; the scoring rubric is at the end.

## Base commit and clean checkout

Every run must start from a **clean checkout at the PD base commit**
`00d93d9780f6800dd757a17f6412ab150b0bf2a7` — i.e. the real PD code WITHOUT the
planted cases from `scratch/reinvention-validation`. The canonical implementations
live at that base. Create a throwaway worktree per run so runs never contaminate each
other:

```bash
# from the AIreuse checkout
git -C ../PD worktree add ../PD-run-A1 --detach 00d93d9780f6800dd757a17f6412ab150b0bf2a7
# ... run the agent with cwd ../PD-run-A1, then:
git -C ../PD-run-A1 diff > runs/T1-A.diff
git -C ../PD worktree remove --force ../PD-run-A1
```

Alternative single worktree: `git -C ../PD-scratch reset --hard 00d93d9 && git -C ../PD-scratch clean -fd` between runs. The per-run worktree is preferred (stronger isolation).

## Run protocol

1. Pick one task and one condition. Use a **fresh agent session with an empty context**
   for every run — never run condition A and condition B in the same conversation, and
   never reuse a session across tasks (contamination: the agent would carry the answer
   forward).
2. Start from a clean checkout at the base commit (above).
3. Give the agent **only** the prompt for that condition verbatim. Do not name files,
   functions, or the existing implementation.
4. Save the resulting working-tree diff (`git diff` plus any new untracked files) as the
   run artifact. Do not rely on the agent's own summary.
5. Score by reading the saved diff (rubric below), not by what the agent claimed.
6. Reset to the base commit before the next run.

## Conditions

- **Condition A (Normal):** the task prompt alone.
- **Condition B (Explicit search):** the exact prefix below, then the task prompt.

Prefix (use verbatim):

> Before writing new code, search the repository carefully for existing implementations that could be reused or extended.

## Task prompts (behavior only — no existing name is given)

**T1 — credential protection at rest**
> In this Shopify app some merchant credentials must be stored at rest in the database.
> Add a small server-side utility that turns a plaintext secret string into a storable
> string, plus its inverse to recover the original. Use authenticated encryption and
> document the storage format.

Existing implementation: `encryptToken` / `decryptToken` (`app/utils/crypto.server.ts`).

**T2 — start of the UTC day**
> Add a helper that returns the start of the current UTC calendar day as a Date, for
> once-per-day gating logic.

Existing implementation: `utcDayStart` (`app/utils/product-surface-stats.server.ts`),
also `todayUtcMidnight` (`app/utils/product-sync.server.ts`).

**T3 — alert throttling for the error reporter**
> The app reports failures to an error reporter. Add a helper that suppresses and counts
> repeated identical alerts within a configurable window while the first occurrence
> always reports.

Existing implementation: `shouldAlertToSentry` (`app/utils/alert-throttle.server.ts`).

**T4 — effective revenue for a row**
> Reporting needs one function that returns the revenue to report for an event row:
> prefer the webhook-confirmed value when present, otherwise the browser-reported value,
> otherwise 0.

Existing implementation: `effectiveRevenue` (`app/utils/verified-revenue.ts`).

**T5 — two-decimal rounding**
> Add a helper that rounds a number to two decimal places for currency display.

Existing implementation: `round2` (`app/utils/order-verification.server.ts`,
`app/utils/attribution.server.ts`, `app/utils/product-surface-stats.server.ts`).

**T6 — numeric id from a Shopify global id**
> Add a helper that extracts the trailing numeric id from a Shopify global id string such
> as `gid://shopify/Product/123`.

Existing implementation: `idFromGid` (`app/utils/product-sync.server.ts`).

## Scoring rubric (read the diff)

- **REUSED** — the diff imports/calls or extends the existing implementation (e.g. an
  import of the existing symbol, or a thin wrapper around it). No equivalent new logic.
- **REINVENTED** — the diff adds a new equivalent implementation with no reference to the
  existing one (new body doing the same job, whether or not the name differs).
- **MIXED** — partial reuse plus new overlapping code (e.g. calls the existing helper for
  the default path but re-implements an edge case). Explain in notes.

For T6, "extends" includes passing a value through the existing helper; "reinvents"
includes a new regex/GID parse that duplicates it.

## Results table (to fill in)

| Task | Existing implementation | Normal (A): reused/reinvented | Explicit (B): reused/reinvented | Notes |
|------|-------------------------|-------------------------------|---------------------------------|-------|
| T1 credential protection | `encryptToken`/`decryptToken` | | | |
| T2 UTC day start | `utcDayStart` | | | |
| T3 alert throttling | `shouldAlertToSentry` | | | |
| T4 effective revenue | `effectiveRevenue` | | | |
| T5 two-decimal rounding | `round2` | | | |
| T6 id from Shopify GID | `idFromGid` | | | |

Interpretation: if condition A reliably reuses, the instruction adds nothing; if A
reinvents and B reuses, the instruction is sufficient and the foundation's job is only
to *explain* the reuse; if B still reinvents, the foundation (or a stronger workflow than
a single instruction) is required.
