# SHOPFLOW — Milestone 6 Phase 9: Transaction integrity and reconciliation

**Status: Verification candidate. Milestone 6 remains OPEN and is not production approved.**

## Corrections and improvements

1. Expanded the accounting reconciliation endpoint to detect:
   - Unbalanced or incomplete journals, including entries with fewer than two lines.
   - Duplicate journal links for source transactions that should have one source journal.
   - Reversal entries with missing or invalid reversal links, mismatched source IDs, missing lines, or originals that are not marked reversed.
   - Original entries marked reversed without a corresponding reversal journal.
   - Reversal links that point to an original entry that is not marked reversed.
   - Reversed source journals, reported separately for review.
2. Updated the accounting screen so the reconciliation status becomes **Needs review** when source transactions are unjournaled, duplicate journals exist, reversal integrity issues exist, or legacy sale lines lack a stored cost snapshot.
3. Tightened journal date validation to reject impossible calendar dates such as February 31, not merely malformed date strings.
4. Reworked `/api/reports/financial` to calculate sales revenue, sales returns, COGS, operating expenses, inventory adjustments, gross profit, net profit and monthly net revenue from the accounting ledger. Reversals now net against the original journal; returns reduce revenue; returned inventory reduces COGS.
5. Corrected the monthly revenue calculation so sales returns are subtracted rather than added.
6. Updated the accounting screen's trial-balance explanation to state that posted entries and reversals are both included.

## Tests performed

| Test | Result |
|---|---|
| `node --check server.js` | PASS |
| `node --check public/app.js` | PASS |
| Current SQLite schema creation | PASS |
| Legacy v5 schema migration simulation | PASS |
| Legacy sale discount/tax allocation backfill | PASS |
| Reconciliation totals and balanced journal checks | PASS |
| Source coverage SQL for sales, purchases, expenses, returns and payments | PASS |
| Duplicate source journal detection | PASS |
| Malformed reversal detection | PASS |
| Reversed original without reversal detection query | PASS (query executed) |
| Reversal target status detection query | PASS (query executed) |
| Financial report calculations with sale, return, COGS, expense, inventory adjustment and reversal | PASS |
| Monthly net revenue with reversal and return | PASS |
| Trial balance and balance-sheet equation simulation | PASS |
| ZIP integrity | PASS |
| Live Express/API/browser testing | NOT RUN |

### Financial simulation

A controlled SQLite scenario produced:

- Gross sales revenue: GH₵90.00
- Sales returns: GH₵18.00
- Net revenue: GH₵72.00
- Cost of goods sold after returned goods: GH₵32.00
- Gross profit: GH₵40.00
- Operating expenses: GH₵5.00
- Inventory adjustments: GH₵1.00
- Net profit: GH₵34.00
- Balance-sheet check: GH₵0.00

A separate GH₵100.00 sale and exact reversal netted to zero in the ledger and monthly report.

## Limitations and acceptance blockers

- The app's Node dependencies have not been installed successfully in this environment, so no live Express/API or browser tests have been performed.
- The migration simulation used a copy of the original v5 schema in an isolated SQLite database; it was not run against the user's live database.
- A real backup/restore and rollback drill is still outstanding.
- Full historical transaction reconciliation using actual SHOPFLOW records is still outstanding.
- Historical cost data is incomplete for some legacy sale lines; those are flagged for review, not reconstructed from current product cost.
- Independent accountant review and security review remain outstanding.

## Acceptance decision

**Milestone 6 remains OPEN. Do not begin Milestone 7 until live application testing, backup/restore and rollback testing, real-data reconciliation, and accounting review are complete.**
