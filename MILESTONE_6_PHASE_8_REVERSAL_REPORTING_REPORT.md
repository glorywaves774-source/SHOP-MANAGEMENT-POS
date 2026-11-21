# SHOPFLOW — Milestone 6 Phase 8: Reversal reporting correction

**Status: Verification candidate only. Milestone 6 remains OPEN and is not production approved.**

## Important correction

A source inspection of the Phase 7 package showed that the accounting report described in its report had not actually been applied consistently in the SQL. Several reports still filtered journal entries to `status='posted'`, which excluded the original entry after it was marked `reversed`.

This phase corrects the accounting report queries to include both `posted` and `reversed` journal entries. The original entry remains in the ledger as audit history, and the reversal entry offsets it. The net account effect is zero.

Updated areas:
- Account balance aggregation
- General ledger account activity
- Trial balance
- Financial statements
- Reconciliation debit/credit totals and invalid-journal checks
- Reconciliation source-transaction checks for sales, purchases, expenses, returns, and initial payments

The reversal endpoint itself continues to accept only an original journal that is currently `posted`, and rejects a second reversal.

## Checks performed

| Check | Result |
|---|---|
| `node --check server.js` | PASS |
| `node --check public/app.js` | PASS |
| Account aggregation SQL with original + reversal | PASS |
| General ledger SQL includes both entries | PASS |
| Trial balance SQL nets original + reversal to zero | PASS |
| Financial statement calculation nets original + reversal to zero | PASS |
| Reconciliation totals include both entries and remain balanced | PASS |
| Source reconciliation accepts a reversed source journal as journaled | PASS (SQL predicate inspection) |
| ZIP integrity | PASS |

A minimal SQLite test posted a GH₵100 sale journal and its exact reversal. The ledger showed both entries; account balances, income, assets, net profit, and balance-sheet check all netted to zero.

## Acceptance blockers remain

- Live Express/API and browser testing has not been run.
- Runtime dependencies have not been installed successfully in this environment.
- No copy of the user's real database has been migrated or rollback-tested.
- Full source-to-ledger reconciliation using representative store data remains outstanding.
- Legacy sale cost snapshots and historical returns need controlled treatment.
- Independent accountant and security reviews remain outstanding.

## Acceptance decision

**Milestone 6 remains OPEN. Do not begin Milestone 7 yet.** Phase 8 corrects a material discrepancy between the Phase 7 report and the actual SQL. It does not establish production readiness.
