# SHOPFLOW — Milestone 6 Phase 7: Accounting acceptance corrections

**Status: Candidate only — Milestone 6 remains OPEN and is not production approved.**

## Corrections made

1. **Journal reversal reporting:** The original journal and its reversal must both remain in the accounting history. Account balances, general ledger, trial balance, statements, and reconciliation now include both `posted` and `reversed` entries. Their debit/credit effects cancel. The original journal remains marked `reversed` as an audit status; it is not deleted.
2. **Store-credit overspending guard:** Available store credit is rechecked inside the same SQLite write transaction that creates the sale and redemption record. This closes the race where two requests could both pass an earlier balance check.
3. **Account aggregation:** Account balances use a conditional aggregate for journal status, avoiding accidental loss of unmatched rows caused by a filtered join.

## Checks performed

| Check | Result |
|---|---|
| `node --check server.js` | PASS |
| `node --check public/app.js` | PASS |
| Three application schema blocks executed in isolated SQLite | PASS |
| Store credit issued GH₵99 and redeemed GH₵60 | PASS |
| Remaining store-credit balance GH₵39 | PASS |
| Insufficient-credit scenario rejected before redemption write | PASS (isolated SQL scenario) |
| Original journal plus reversal net to zero in account balances | PASS |
| Reversal journal remains balanced | PASS |
| ZIP integrity | PASS |

## Not verified / acceptance blockers

- Live Express/API and browser tests were not run because runtime dependencies are not installed in the working environment.
- The user's actual production database has not been copied, migrated, backed up, or rollback-tested.
- Concurrent HTTP redemption load testing was not possible. The balance check is now inside the SQLite transaction, but this still requires multi-request runtime testing.
- Full end-to-end source-to-ledger reconciliation with representative real business transactions is outstanding.
- Legacy sales with missing cost snapshots and historical returns need a controlled reconciliation policy.
- Store-credit expiry, manual adjustment/void controls, and refund policy approval are not part of this phase.
- Independent accountant review and security review remain outstanding.

## Acceptance decision

**Do not mark Milestone 6 complete. Do not begin Milestone 7 yet.** This phase fixes two material accounting integrity issues and passes isolated static/SQLite checks, but it is not a substitute for live integration, real-database migration rehearsal, or accountant sign-off.
