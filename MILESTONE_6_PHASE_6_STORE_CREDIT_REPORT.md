# SHOPFLOW — Milestone 6 Phase 6: Store-credit lifecycle

**Status:** Implementation candidate; not production approved.

## Implemented
- Added customer-linked store-credit transaction ledger with `issued` and `redeemed` entries.
- Store-credit refunds require the original sale to have a linked customer.
- POS supports store credit as a full payment method and as the tender method for a part-payment.
- Sale validation checks the customer's available store-credit balance before posting.
- Store-credit redemption debits account 2200; store-credit return issuance credits account 2200.
- Customer list and customer ledger show available store-credit balances and activity.
- JSON backup/export includes the store-credit ledger.
- Fixed credit-only sale tender selection so a credit sale with zero paid amount uses no cash receipt line.

## Checks performed
| Check | Result |
|---|---|
| `node --check server.js` | PASS |
| `node --check public/app.js` | PASS |
| Fresh SQLite schema creation from application schema blocks | PASS |
| Store-credit ledger issuance/redemption SQL simulation | PASS |
| Balance after issuing 50.00 and redeeming 20.00 | PASS — 30.00 |
| ZIP archive integrity | PASS |

## Not yet verified
- Live Express/API and browser workflows (dependencies unavailable in the working environment).
- Actual user database migration and rollback rehearsal.
- Concurrency/race testing for simultaneous redemption attempts.
- Full accounting reconciliation with live transaction data and independent accountant review.

## Decision
Milestone 6 remains OPEN. This phase closes the basic store-credit lifecycle in code, but does not satisfy live acceptance or production-readiness requirements. Continue with the final Milestone 6 acceptance and deployment-readiness gate; do not start Milestone 7 until the gate passes.
