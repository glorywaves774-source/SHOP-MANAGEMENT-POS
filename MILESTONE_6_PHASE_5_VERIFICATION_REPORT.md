# SHOPFLOW — Milestone 6 Phase 5 Verification Report

**Verification date:** 21 November 2026  
**Status:** Verification candidate only — Milestone 6 is NOT approved for production.

## Scope reviewed

- Chart of accounts and default account seeding
- Journal entry and journal line schema
- Double-entry validation in `postJournal`
- Sales, purchases, expenses, customer receipts, supplier payments, stock adjustments, and returns posting paths
- Trial balance and financial statement calculations
- Reconciliation query coverage
- Sale-line discount/tax allocation and partial-return allocation
- Opening-balance restrictions and journal reversal flow

## Checks completed

| Check | Result |
|---|---|
| `node --check server.js` | PASS |
| `node --check public/app.js` | PASS |
| Fresh SQLite schema creation from all three application schema blocks | PASS |
| Journal balancing simulations for sale, purchase, expense, receipt, supplier payment, return and opening balance | PASS |
| Trial-balance debit/credit total simulation | PASS |
| Balance-sheet equation simulation including current-period profit | PASS |
| Sale discount/tax allocation and cent rounding simulation | PASS |
| Repeated partial-return allocation simulation | PASS |
| Legacy schema column-addition and allocation backfill simulation | PASS |
| Reconciliation SQL compilation against the full schema | PASS |
| Regression test: a reversed source journal is no longer treated as active coverage | PASS |
| ZIP integrity | PASS |

The checks above are static, schema-level, and isolated SQLite simulations. They do not constitute a live application test.

## Correction made during Phase 5

Reconciliation source coverage now requires the linked source journal to have `status='posted'`. A source record whose only journal was reversed is therefore reported as unjournaled until it has a valid posted accounting entry. The initial-payment exception also requires the originating sale/purchase journal to remain posted.

## Outstanding blockers before Milestone 6 approval

1. **Live runtime testing:** `node_modules` is not present in this working copy. Earlier dependency installation attempts timed out and offline installation could not retrieve `better-sqlite3`. HTTP/API workflows could not be executed.
2. **Real database migration:** The migration was simulated against a representative legacy schema, not a copy of the user's production database. Back up the database and test migration/rollback on a copy before deployment.
3. **Historical source journals:** Existing sales, purchases, expenses, returns, and payment records created before automatic journal posting may be flagged as unjournaled. A controlled opening/conversion process is still required; do not silently generate historical journals without reconciliation to source records.
4. **Legacy cost data:** Older sale lines with `cost_price=0` do not contain reliable sale-time cost snapshots. Historical COGS and margin cannot be reconstructed from today's product cost without an approved method.
5. **Store-credit lifecycle:** Returns can issue a store-credit liability, but redemption against a later sale and customer-level store-credit balance controls still need implementation and testing.
6. **Financial controls:** No independent accountant review, tax configuration review, period-close process, or production backup/restore drill has been completed.
7. **Integration verification:** The accounting UI and all workflows need browser/API tests with realistic users and data, including authorization checks and concurrent transactions.

## Approval decision

**Milestone 6 remains OPEN.** The code has useful double-entry foundations and passed the listed static/database simulations, but production approval would be premature until the outstanding blockers are resolved. Milestone 7 must remain on hold until Milestone 6 passes its live acceptance tests and receives accounting review.
