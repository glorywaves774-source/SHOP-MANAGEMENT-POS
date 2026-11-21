# SHOPFLOW — Shop Management & POS (Milestone 6 development)

A responsive shop management system using:
- Charcoal `#2B2D31`
- Light grey `#D9DADC`
- Gold yellow `#FFC93C`

## Features in this build
- Dashboard with daily sales, revenue, inventory and low-stock summaries
- Point of Sale with product search, category filters, cart and quantity controls
- Cash, Mobile Money, Card and Bank Transfer checkout
- Discounts, tax entry, change calculation and thermal-ready receipts (58 mm or 80 mm, your shop name, reprint from Sales)
- Product catalogue, separate SKU and barcode fields, cost/selling prices and reorder levels
- Barcode scanning at the POS: scan, and the item goes straight into the cart (handheld scanner, or the phone/webcam camera for barcodes and QR codes)
- Sales history and transaction details
- Customer records and expense tracking
- Supplier directory
- Purchase receiving that increases product stock and updates product cost
- Returns and refunds against original sale items; returned quantities are restored to stock
- Staff accounts with Administrator, Manager and Cashier roles
- First-run administrator setup, hashed passwords, signed random session tokens stored as hashes, HttpOnly cookies and login rate limiting
- Sales reports and administrator-only JSON data export
- Stock movement audit trail for sales, purchases, returns and manual stock adjustments
- Physical stock-count adjustment with mandatory reason and recorded user
- Cashier shift opening and closing with opening float, cash sales, cash refunds, expected cash and cash variance
- Customer credit and part-payment sales, with customer account balances and payment history
- Customer payment collection that allocates receipts against outstanding invoices
- Supplier purchase bills with initial payments and outstanding balances
- Supplier payment recording and balance reduction against oldest outstanding purchases
- Purchase orders created before delivery, with partial and multiple delivery receiving
- Stocktake workflow that records system quantity, physical count, variance and adjustment audit trail
- Internal stock transfer register with source/destination locations and product quantities
- Financial overview with revenue, cost of goods sold from stored sale-time cost snapshots for new transactions, gross profit, operating expenses, refunds, net operating result, receivables and payables
- Double-entry chart of accounts with seeded default accounts and administrator account creation
- Automatic balanced journal posting for sales, purchases, operating expenses, returns, customer receipts, supplier payments and inventory adjustments
- Manual journal entries with server-side debit/credit validation
- General ledger, trial balance, income statement and balance sheet views
- One-time opening-balance journal posting, journal history and administrator reversal workflow
- Accounting reconciliation endpoint covering unjournaled source records, unbalanced journals and legacy sales without stored cost snapshots
- Weighted-average product cost updates on new purchase receipts
- Sales linked to the cashier’s open shift; shift data and inventory movement history included in JSON export
- SQLite database; `DATABASE_PATH` environment variable supports persistent disk mounting
- Responsive desktop, tablet and mobile interface

## Barcode scanner and receipt printer

**Scanner.** Any USB or Bluetooth scanner that behaves like a keyboard ("HID keyboard" mode) works. It must send **Enter** after each scan, which is the factory default on most models.
1. Products > Add/Edit product > click the **Barcode** field and scan the product. (SKU stays your own internal code.)
2. At the POS the search box is focused when the page opens. Scan: the exact barcode or SKU (any letter case) is added to the cart, the box clears, and a short beep confirms it. An unknown or out-of-stock code gives a low beep and a message. If the cashier clicked elsewhere, the first scanned character moves focus back to the search box.
3. The same box still works for typing a name; press Enter to add when only one product matches.

**Receipt printer.** Receipts print through the browser, so install the printer's driver in the operating system first.
1. Settings > Business profile: set the shop name, address, phone and footer (saved on the server, used on every receipt).
2. Settings > Receipt printer: choose **58 mm** or **80 mm**. This is saved per browser/computer, so each till can have its own printer.
3. Click **Print test receipt**. In the print dialog pick the receipt printer and set Margins to **None**. If your driver offers a paper size, choose the roll width (or "continuous").
4. To skip the dialog on a dedicated till, start Chrome with `--kiosk-printing` and set the receipt printer as the system default.

**Scanner test.** Settings > **Test scanner** shows exactly what your scanner sends (the code, whether it pressed Enter, whether it types at scanner speed) and whether the code matches a product. Use it first when setting up a new scanner.

**Camera scanning (barcodes and QR codes).** At the POS click **📷 Scan with camera**. Chrome/Edge (Android and desktop) use the browser's built-in scanner. iPhone Safari and Firefox have none, so the app loads the open-source ZXing reader from the jsDelivr CDN the first time you tap the button (needs internet; it is not downloaded on other browsers). It needs HTTPS (your Render URL is fine) plus camera permission. On iPhone, allow camera access for Safari when asked. To use QR codes, put the QR's text in the product's Barcode field. Each read adds one item; the same code is ignored for 2 seconds so one scan is not counted twice.

Limits of browser printing: it does not send ESC/POS commands, so it cannot open a cash drawer by itself, and auto-cut depends on the printer driver's settings. Always test with your real scanner and printer before going live.

## Requirements
Node.js 20+ recommended.

## Run locally
```bash
npm install
cp .env.example .env
npm start
```
Open http://localhost:3000. On first launch, create the first administrator account. Use a unique password of at least 10 characters.

## Render deployment
1. Push the project to GitHub.
2. Create a Render Web Service connected to the repository.
3. Build command: `npm install`
4. Start command: `npm start`
5. Add a persistent disk mounted at `/var/data`.
6. Set environment variable `DATABASE_PATH=/var/data/shop.db`.
7. Set `NODE_ENV=production`.
8. Deploy, then open the service and complete first-run administrator setup.

## Important production notes
This is a development milestone, not a certified production POS. Before handling live commercial transactions:
- Configure HTTPS and verify secure cookies on the deployed domain.
- Add CSRF protection, stricter validation, audit trails and security review.
- Add automated off-site backups and tested restore procedures for the persistent database.
- Test barcode scanner models, cash drawers, thermal printers, tax rules and payment integrations on actual devices.
- Add purchase cancellation/adjustment controls, refund approval workflow and formal end-of-day supervisory sign-off.
- Confirm business-specific tax and privacy requirements.
- For multi-instance or higher-volume deployment, migrate to managed PostgreSQL and a production session store.
- Cashier and manager UI controls should be tested against the server-enforced role permissions before production use.

## Milestone 6 verification status and limitations
- This is an accounting implementation under verification, not a certified accounting product or audited financial statement system. A live database migration, end-to-end transaction tests and accountant review are still required before production use.
- New sale lines store the product cost at the time of sale. Legacy sale lines are migrated with a zero cost snapshot because their true historical cost cannot be reconstructed reliably from the current product record; the reconciliation report flags these records.
- Product cost on purchase receipts is updated using a weighted-average calculation. Existing historical product costs and stock values are not retroactively reconstructed.
- The opening-balance workflow is a one-time balanced journal posting. Correcting opening balances requires an approved adjusting journal; the system intentionally prevents a second opening-balance batch.
- Inventory adjustments and stocktake variances use the product's current weighted-average cost as the valuation basis. FIFO/serial/lot costing and formal period-end inventory valuation are not implemented.
- Customer and supplier payments are allocated against oldest outstanding balances; selecting a specific invoice is not yet available in the user interface.
- Branch/location-specific stock balances are not yet maintained; transfer records are an audit register only.
- Purchases are recorded as received immediately; draft purchase orders and partial receiving are not yet implemented.
- Return processing currently handles one product line per return form submission.
- Payment methods are recorded as tender types; there is no live Mobile Money or card gateway integration.
- Supplier and customer payment ledgers, chart of accounts, journal entries, journal lines and accounting controls are included in the administrator JSON backup; import/restore is not yet implemented.
- Cashier shift reconciliation is available, but the system does not yet enforce that every sale must belong to an open shift.
- Stock movement history begins with this milestone; historical movements from before this update are not reconstructed.

### Additional verification notes (2026-11-21)
- Card receipts/payments now post to a dedicated Card Clearing asset account instead of being classified as cash. Store-credit refunds post to a Store Credit Liability account; redemption of store credit on a later sale is not implemented yet.
- Part-payment sales now collect a separate tender method so the received amount can be posted to Cash, Mobile Money, Bank or Card Clearing while the remaining amount is posted to Accounts Receivable.
- Returns restore inventory at the sale-line cost snapshot and recalculate the product's weighted-average cost. The return form still needs a tax/discount allocation policy before refunds can be considered fully reconciled for sales where tax or discounts were applied.
- The reconciliation check excludes the initial-payment memo rows whose cash leg is already included in the original sale or purchase journal, preventing them from being falsely reported as missing journals.
- Purchase receipts update weighted-average cost using the latest stock and cost in the database, including multiple lines for the same product in a single receipt.
- Source syntax checks and SQLite schema/accounting SQL smoke tests passed in this work session. Full HTTP/runtime tests were not run because package installation could not complete in this environment; install dependencies and run the application against a disposable test database before accepting this milestone.

### Milestone 6 — Phase 4 return-tax and discount allocation (2026-11-21)

- New sales now store each sale line's allocated discount and tax, with cent-level rounding distributed across lines so the allocations reconcile to the sale header.
- Partial returns calculate the proportional discount and tax attributable to the returned quantity. Cumulative allocation is used across repeated partial returns so the final return does not lose or duplicate rounding cents.
- Return journals debit Sales Returns for the net-of-discount amount, debit Tax Payable for the returned tax, and credit the selected refund tender or Store Credit Liability for the total refund. Inventory and cost-of-goods-sold restoration remains a separate balanced pair.
- New sales reject duplicate product lines in a single cart because the current return API identifies sale lines by product ID.
- Existing sale lines are backfilled with proportional discount/tax allocations on upgrade. Existing historic return journals are not rewritten or restated; returns processed before this upgrade may not reflect the new tax/discount allocation treatment. Review historical returns before relying on comparative return reporting.
- Checks performed: JavaScript syntax checks; SQLite schema creation and migration-column checks; allocation-total and repeated-partial-return rounding simulations. Live HTTP/runtime tests and a migration against a copy of a real production database remain outstanding because the project dependencies could not be installed in the prior verification attempt.

## Milestone 6 Phase 5 verification

See `MILESTONE_6_PHASE_5_VERIFICATION_REPORT.md` for the checks completed, the reconciliation correction, and the outstanding blockers. The accounting milestone remains a verification candidate and is not approved for production until live API/runtime tests, real-database migration testing, historical data reconciliation, store-credit redemption, and independent accounting review are completed.

## Store credit lifecycle (Milestone 6 Phase 6)

- A return may issue store credit only when the original sale is linked to a customer.
- Store-credit issuance is recorded against that customer and the originating return.
- Store credit may be redeemed as a full POS tender or as the tender component of a part-payment sale. A customer must be selected and the available balance is checked inside the sale transaction.
- Issuance credits account 2200 (Store Credit Liability); redemption debits account 2200. The corresponding sale/return journal remains the accounting source of record.
- Customer credit views show the available store-credit balance and transaction history. JSON export includes store-credit transactions.
- Cash/bank/card/Mobile Money receipts against customer credit remain separate from store-credit redemption.

This implementation has passed syntax, schema and isolated ledger simulations. It has not yet passed live HTTP/runtime testing or a production database migration rehearsal.


## Milestone 6 Phase 7 acceptance corrections (2026-11-21)

- Journal reversals remain part of posted accounting history: original and reversal entries are both included in account balances, general ledger, trial balance, statements, and reconciliation totals. This ensures the two entries offset rather than reporting only the reversal.
- Store-credit balance is rechecked inside the same SQLite write transaction that records redemption, preventing two concurrent requests from spending the same available balance.
- Account balance aggregation now correctly filters journal status in the aggregate expression rather than excluding unmatched journal rows in the join.
- Static/database checks only; live HTTP/browser, real-world database migration/rollback, concurrency load, and independent accounting sign-off remain outstanding.


## Milestone 6 Phase 9 — Transaction integrity and reconciliation

The accounting reconciliation now reports duplicate source journals, invalid or incomplete reversal relationships, reversed source journals, unjournaled source records, and legacy sale lines without cost snapshots. Financial reporting totals are derived from the posted journal ledger and include the net effect of journal reversals and returns. Journal dates are checked as real calendar dates. See `MILESTONE_6_PHASE_9_RECONCILIATION_REPORT.md` for the test results and remaining acceptance blockers.


## Milestone 6 Phase 10 — defect fixes
See `MILESTONE_6_PHASE_10_FIXES_REPORT.md`. Run the regression suite with `npm test`. Demo products are no longer loaded automatically; set `SEED_DEMO_DATA=true` on a disposable dev database to load them. Stock and cost of existing products can only change through purchases, stocktakes/adjustments and returns, so the ledger and stock stay in agreement; the reconciliation screen now compares stock, customer balances, supplier balances and store credit to the ledger.
