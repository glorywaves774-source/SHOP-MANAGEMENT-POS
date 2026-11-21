# SHOPFLOW — Milestone 6 Phase 10: defect fixes from live testing

**Status: verification candidate. Milestone 6 remains OPEN (see "Still outstanding").**

Phase 9 was never run. This phase installed dependencies, ran the app against a throwaway database, reproduced the defects below, fixed them, and added a repeatable regression suite (`npm test`, 14 tests, all passing).

## Defects fixed

| # | Defect (reproduced) | Fix |
|---|---|---|
| 1 | PO receipts changed stock/cost with no journal, bill or payable; reconciliation still said "balanced" | PO receipt now creates a supplier bill + `purchase` journal (Dr Inventory / Cr Cash-or-AP), uses weighted-average cost, accepts an optional payment, rejects duplicate lines |
| 2 | Reconciliation ignored sub-ledgers (inventory showed GH₵10 in the ledger vs GH₵9,211 on hand) | Added checks: stock x cost vs 1200, customer balances vs 1100, supplier balances vs 2000, store credit vs 2200. UI flags "Needs review" when any differ |
| 3 | Stored XSS (any user text rendered via `innerHTML`; cashiers can create customers) | All server text is HTML-escaped once in `api()`; unsafe inline-handler interpolations (supplier name, category) replaced with `data-` attributes |
| 4 | Cash change impossible (server rejected overpayment) | Cash sales may be overpaid; change is recorded, only the sale total is booked. Non-cash overpayment still rejected |
| 5 | Raw 500 pages / SQL errors (delete product with history, `quantity:"abc"`, malformed JSON) | Quantity validation, JSON error handler, 404 for unknown `/api` paths, friendly delete errors |
| 6 | Purchases/supplier payments accepted any payment method ("Store Credit" posted to the liability account) | Whitelist: Cash, Mobile Money, Bank Transfer, Card |
| 7 | Last admin could be demoted/deactivated | Blocked; deactivating a user also ends their sessions |
| 8 | Direct product edits and seeded demo data changed stock/cost with no journal | Stock/cost can no longer be edited on existing products; new products with opening stock post Dr Inventory / Cr Owner Equity; demo seed is opt-in (`SEED_DEMO_DATA=true`) and journaled |
| 9 | Return on a credit/part-paid sale refunded cash while the customer still owed money | Return first reduces the sale's balance (credits Accounts Receivable); only the remainder is refunded in the chosen tender |
| 10 | Journal reversal of sales/purchases/etc. reversed the ledger but not stock or balances | Only manual journals can be reversed directly |
| 11 | Shift expected cash ignored cash part-payments and cash receipts; live view ignored refunds | One `shiftCash()` calculation used by the live view, list and close |
| 12 | Stocktake/transfer accepted the same product twice (wrong variances/journals) | Duplicates rejected |
| 13 | Cashiers could read product costs, reports, returns and movements; cashier name on a sale was client-supplied | Cost stripped for cashiers; those routes are manager/admin; cashier name comes from the session |
| 14 | Reports showed different gross profit figures; dashboard revenue ignored refunds | Reports gross profit read from the ledger; dashboard shows net revenue |
| 15 | Rate limit would be shared by all users behind Render's proxy and counted successful logins | `trust proxy` in production; successful logins not counted |
| 16 | "Legacy sale lines" flag also caught zero-cost products | Uses an explicit `cost_snapshot` marker |
| 17 | **Dead UI:** stocktake/transfer page, direct stock receiving and the PO payment UI were unreachable; dashboard showed literal `${d.today.orders}` | Navigation fixed, buttons added, template bug fixed |

## Verification performed
- `npm test`: 14/14 pass (live HTTP against a temporary database: auth, validation, sales/change, PO receipts, credit-sale returns, store credit, shifts, stocktake, reversals, permissions, report/ledger agreement, seeding, HTML escaping).
- The same suite fails against the Phase 9 code.
- A database created by the Phase 9 build opens under this build; new columns are added and existing data is retained.

## Upgrading an existing database
- Take a backup first (`/api/export` plus a copy of the `.db` file).
- If the old demo products were loaded, the inventory check will show a difference. Post a one-off manual journal Dr 1200 Inventory / Cr 3000 Owner Equity for the difference (or use the opening-balance form if not yet used).
- Customer-facing history is not rewritten: old returns and old PO receipts keep their original treatment.

## Still outstanding (not done)
- No browser/UI automation was run; the UI changes were checked by syntax check and the escaping unit test only. Click through POS, Purchases, Inventory Control, Credit and Finance before accepting.
- CSRF protection, cancelling/amending purchases and POs, refund approval, branch-level stock, expense payment methods (still always Cash).
- Cashiers can still create customers (needed at POS); this is now safe against XSS but remains a policy decision.
- Real-data migration rehearsal, backup/restore drill, independent accounting and security review.
