// Run with: npm test   (uses a throwaway SQLite database and a random port)
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(path.join(tmpdir(), "shopflow-"));
const PORT = 3200 + Math.floor(Math.random() * 500);
const base = `http://127.0.0.1:${PORT}/api`;
let server;

function start(env = {}, port = PORT, db = "main.db") {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ["server.js"], { cwd: root, env: { ...process.env, PORT: String(port), DATABASE_PATH: path.join(dir, db), ...env } });
    p.stdout.on("data", d => { if (String(d).includes("listening")) resolve(p); });
    p.on("error", reject);
    setTimeout(() => reject(new Error("server did not start")), 8000);
  });
}
class Client {
  constructor(b = base) { this.b = b; this.cookie = ""; }
  async call(method, url, body) {
    const r = await fetch(this.b + url, { method, headers: { "Content-Type": "application/json", cookie: this.cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.get("set-cookie"); if (sc) this.cookie = sc.split(";")[0];
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, text };
  }
  get(u) { return this.call("GET", u); } post(u, b) { return this.call("POST", u, b); }
  put(u, b) { return this.call("PUT", u, b); } patch(u, b) { return this.call("PATCH", u, b); } del(u) { return this.call("DELETE", u); }
}
const admin = new Client(), cashier = new Client();
const ids = {};
const recon = async () => (await admin.get("/accounting/reconciliation")).json;
const assertReconciled = async (label) => {
  const r = await recon();
  assert.equal(r.balanced, true, label + ": ledger balanced");
  assert.deepEqual(r.invalid_entries, [], label + ": no invalid journals");
  for (const c of r.subledger_checks) assert.equal(c.ok, true, `${label}: ${c.name} differs by ${c.difference}`);
  assert.ok(Object.values(r.unjournaled).every(n => n === 0), label + ": nothing unjournaled");
};

test.before(async () => { server = await start(); });
test.after(() => { server?.kill(); rmSync(dir, { recursive: true, force: true }); });

test("setup, staff and last-admin protection", async () => {
  assert.ok([200, 201].includes((await admin.post("/auth/signup", { shop_name: "Test Shop", shop: "testshop", name: "Admin", username: "admin", password: "longpassword1" })).status));
  const u = await admin.post("/users", { name: "Cash", username: "cash1", password: "longpassword1", role: "cashier" });
  assert.equal(u.status, 201); ids.cashierUser = u.json.id;
  assert.equal((await cashier.post("/auth/login", { shop: "testshop", username: "cash1", password: "longpassword1" })).status, 200);
  const me = (await admin.get("/auth/me")).json;
  const demote = await admin.patch(`/users/${me.id}`, { role: "cashier" });
  assert.equal(demote.status, 400); assert.match(demote.json.error, /administrator/i);
  assert.equal((await admin.patch(`/users/${me.id}`, { active: false })).status, 400);
});

test("fresh install has no demo products; creating stock is journaled", async () => {
  assert.deepEqual((await admin.get("/products")).json, []);
  const a = await admin.post("/products", { name: "Rice", sku: "R1", price: 100, cost: 60, stock: 10, reorder_level: 2 });
  const b = await admin.post("/products", { name: "Oil", sku: "O1", price: 40, cost: 25, stock: 0, reorder_level: 2 });
  assert.equal(a.status, 201); ids.rice = a.json.id; ids.oil = b.json.id;
  assert.equal((await admin.post("/products", { name: "Bad", price: 5, stock: -3 })).status, 400);
  await assertReconciled("after product creation");
});

test("product edits cannot bypass stock/cost controls; delete is handled", async () => {
  const rice = (await admin.get("/products")).json.find(p => p.id === ids.rice);
  const stock = await admin.put(`/products/${ids.rice}`, { ...rice, stock: 99 });
  assert.equal(stock.status, 400); assert.match(stock.json.error, /stock/i);
  const cost = await admin.put(`/products/${ids.rice}`, { ...rice, cost: 1 });
  assert.equal(cost.status, 400);
  assert.equal((await admin.put(`/products/${ids.rice}`, { ...rice, price: 105 })).status, 200);
  const del = await admin.del(`/products/${ids.rice}`);
  assert.equal(del.status, 400); assert.ok(del.json?.error, "returns JSON, not an HTML stack trace");
});

test("input validation returns JSON errors", async () => {
  const bad = await admin.post("/sales", { items: [{ product_id: ids.rice, quantity: "abc" }], payment_method: "Cash", amount_paid: 0 });
  assert.equal(bad.status, 400); assert.match(bad.json.error, /quantity/i);
  const sup = (await admin.post("/suppliers", { name: "Acme" })).json; ids.sup = sup.id;
  const pq = await admin.post("/purchases", { supplier_id: ids.sup, items: [{ product_id: ids.rice, quantity: "abc", unit_cost: 5 }] });
  assert.equal(pq.status, 400); assert.ok(pq.json?.error);
  const pm = await admin.post("/purchases", { supplier_id: ids.sup, items: [{ product_id: ids.rice, quantity: 1, unit_cost: 5 }], amount_paid: 5, payment_method: "Store Credit" });
  assert.equal(pm.status, 400);
  const json = await fetch(base + "/products", { method: "POST", headers: { "Content-Type": "application/json", cookie: admin.cookie }, body: "{bad" });
  assert.equal(json.status, 400); assert.ok((await json.json()).error);
  assert.equal((await admin.get("/nope")).status, 404);
});

test("cash overpayment gives change; non-cash overpayment is rejected", async () => {
  const ok = await admin.post("/sales", { items: [{ product_id: ids.rice, quantity: 1 }], payment_method: "Cash", amount_paid: 200 });
  assert.equal(ok.status, 201); assert.equal(ok.json.total, 105); assert.equal(ok.json.amount_paid, 200); assert.equal(ok.json.change_due, 95); assert.equal(ok.json.amount_received, 105);
  const bad = await admin.post("/sales", { items: [{ product_id: ids.rice, quantity: 1 }], payment_method: "Card", amount_paid: 500 });
  assert.equal(bad.status, 400);
  await assertReconciled("after cash sale");
});

test("purchase-order receipt posts stock, weighted cost, supplier bill and journal", async () => {
  const po = (await admin.post("/purchase-orders", { supplier_id: ids.sup, items: [{ product_id: ids.oil, quantity: 10, unit_cost: 30 }] })).json;
  const detail = (await admin.get(`/purchase-orders/${po.id}`)).json;
  const line = detail.items[0].id;
  const dup = await admin.post(`/purchase-orders/${po.id}/receive`, { items: [{ item_id: line, quantity: 5 }, { item_id: line, quantity: 5 }] });
  assert.equal(dup.status, 400);
  const r1 = await admin.post(`/purchase-orders/${po.id}/receive`, { items: [{ item_id: line, quantity: 6 }], amount_paid: 60, payment_method: "Cash" });
  assert.equal(r1.status, 200); assert.equal(r1.json.status, "part_received"); assert.equal(r1.json.total, 180); assert.equal(r1.json.balance_due, 120);
  const r2 = await admin.post(`/purchase-orders/${po.id}/receive`, { items: [{ item_id: line, quantity: 4 }] });
  assert.equal(r2.json.status, "received");
  const oil = (await admin.get("/products")).json.find(p => p.id === ids.oil);
  assert.equal(oil.stock, 10); assert.equal(oil.cost, 30);
  const bal = (await admin.get("/credit/suppliers")).json.find(s => s.id === ids.sup);
  assert.equal(bal.balance_due, 240); // 120 + 120 unpaid
  const pay = await admin.post(`/credit/suppliers/${ids.sup}/payments`, { amount: 40, method: "Nonsense" });
  assert.equal(pay.status, 400);
  assert.equal((await admin.post(`/credit/suppliers/${ids.sup}/payments`, { amount: 40, method: "Bank Transfer" })).status, 201);
  await assertReconciled("after PO receipts and supplier payment");
});

test("credit sale, return offsets receivable, receipts and store credit stay reconciled", async () => {
  const cust = (await admin.post("/customers", { name: "Ama" })).json; ids.cust = cust.id;
  const sale = await admin.post("/sales", { items: [{ product_id: ids.oil, quantity: 5 }], payment_method: "Credit", amount_paid: 0, customer_id: ids.cust });
  assert.equal(sale.status, 201); assert.equal(sale.json.balance_due, 200); ids.creditSale = sale.json.id;
  const ret = await admin.post("/returns", { sale_id: ids.creditSale, reason: "damaged", refund_method: "Cash", items: [{ product_id: ids.oil, quantity: 2 }] });
  assert.equal(ret.status, 201); assert.equal(ret.json.total, 80); assert.equal(ret.json.receivable_offset, 80); assert.equal(ret.json.refund_paid, 0);
  let ledger = (await admin.get(`/credit/customers/${ids.cust}/ledger`)).json; assert.equal(ledger.balance_due, 120);
  assert.equal((await admin.post(`/credit/customers/${ids.cust}/payments`, { amount: 100, method: "Mobile Money" })).status, 201);
  // customer already paid more than remaining after next return: the rest is refunded as store credit
  const ret2 = await admin.post("/returns", { sale_id: ids.creditSale, reason: "wrong item", refund_method: "Store Credit", items: [{ product_id: ids.oil, quantity: 2 }] });
  assert.equal(ret2.json.receivable_offset, 20); assert.equal(ret2.json.refund_paid, 60);
  ledger = (await admin.get(`/credit/customers/${ids.cust}/ledger`)).json; assert.equal(ledger.balance_due, 0); assert.equal(ledger.store_credit_balance, 60);
  const over = await admin.post("/returns", { sale_id: ids.creditSale, reason: "x", refund_method: "Cash", items: [{ product_id: ids.oil, quantity: 5 }] });
  assert.equal(over.status, 400);
  await assertReconciled("after credit sale and returns");
});

test("shift expected cash counts cash part-payments, receipts and refunds", async () => {
  assert.equal((await admin.post("/shifts/open", { opening_cash: 100 })).status, 201);
  const cust = (await admin.post("/customers", { name: "Kofi" })).json;
  const s = await admin.post("/sales", { items: [{ product_id: ids.rice, quantity: 2 }], payment_method: "Part payment", tender_method: "Cash", amount_paid: 50, customer_id: cust.id });
  assert.equal(s.status, 201);
  assert.equal((await admin.post(`/credit/customers/${cust.id}/payments`, { amount: 30, method: "Cash" })).status, 201);
  assert.equal((await admin.post("/sales", { items: [{ product_id: ids.oil, quantity: 1 }], payment_method: "Cash", amount_paid: 50 })).status, 201); // 40 cash
  const ret = await admin.post("/returns", { sale_id: s.json.id, reason: "r", refund_method: "Cash", items: [{ product_id: ids.rice, quantity: 1 }] });
  assert.equal(ret.status, 201);
  const cur = (await admin.get("/shifts/current")).json;
  const refundCash = ret.json.total - ret.json.receivable_offset;
  assert.equal(cur.cash_sales, 90); assert.equal(cur.cash_receipts, 30);
  assert.equal(Math.round(cur.cash_refunds * 100), Math.round(refundCash * 100));
  assert.equal(Math.round(cur.expected_cash * 100), Math.round((100 + 90 + 30 - refundCash) * 100));
  const close = await admin.post(`/shifts/${cur.id}/close`, { closing_cash: cur.expected_cash });
  assert.equal(close.json.cash_difference, 0);
  await assertReconciled("after shift activity");
});

test("stocktake and transfers reject duplicate lines; stocktake is journaled", async () => {
  const dup = await admin.post("/inventory/stocktake", { items: [{ product_id: ids.oil, counted_qty: 1 }, { product_id: ids.oil, counted_qty: 2 }] });
  assert.equal(dup.status, 400);
  assert.equal((await admin.post("/inventory/transfers", { from_location: "A", to_location: "B", items: [{ product_id: ids.oil, quantity: 1 }, { product_id: ids.oil, quantity: 1 }] })).status, 400);
  assert.equal((await admin.post("/inventory/stocktake", { items: [{ product_id: ids.oil, counted_qty: 1 }] })).status, 201);
  await assertReconciled("after stocktake");
});

test("journal reversal: manual only", async () => {
  const journals = (await admin.get("/accounting/journals")).json;
  const sysJ = journals.find(j => j.source_type === "sale");
  assert.equal((await admin.post(`/accounting/journals/${sysJ.id}/reverse`)).status, 400);
  const accts = (await admin.get("/accounting/accounts")).json;
  const cash = accts.find(a => a.code === "1000").id, eq = accts.find(a => a.code === "3000").id;
  const m = await admin.post("/accounting/journals", { description: "Owner top-up", entry_date: "2026-11-01", lines: [{ account_id: cash, debit: 10 }, { account_id: eq, credit: 10 }] });
  assert.equal(m.status, 201);
  assert.equal((await admin.post("/accounting/journals", { description: "bad", entry_date: "2026-02-31", lines: [{ account_id: cash, debit: 1 }, { account_id: eq, credit: 1 }] })).status, 400);
  assert.equal((await admin.post(`/accounting/journals/${m.json.id}/reverse`)).status, 200);
  await assertReconciled("after manual journal reversal");
});

test("cashier permissions and information exposure", async () => {
  const prods = (await cashier.get("/products")).json;
  assert.ok(prods.length && prods.every(p => !("cost" in p)), "cashier must not see cost prices");
  for (const u of ["/reports/overview", "/returns", "/inventory/movements", "/accounting/reconciliation", "/reports/financial"]) assert.equal((await cashier.get(u)).status, 403, u);
  assert.equal((await cashier.post("/returns", { sale_id: 1, reason: "x", items: [] })).status, 403);
  const sale = await cashier.post("/sales", { items: [{ product_id: ids.rice, quantity: 1 }], payment_method: "Cash", amount_paid: 105, cashier: "Someone Else" });
  assert.equal(sale.status, 201); assert.equal(sale.json.cashier, "Cash", "cashier name is taken from the session, not the request");
});

test("reports agree with the ledger", async () => {
  const fin = (await admin.get("/reports/financial")).json, ov = (await admin.get("/reports/overview")).json;
  assert.equal(ov.gross, fin.gross_profit);
  const st = (await admin.get("/accounting/statements")).json; assert.ok(Math.abs(st.balance_check) < 0.005);
});

test("demo data is journaled when SEED_DEMO_DATA=true", async () => {
  const port = PORT + 600, p = await start({ SEED_DEMO_DATA: "true" }, port, "seed.db");
  try {
    const c = new Client(`http://127.0.0.1:${port}/api`);
    await c.post("/auth/signup", { shop_name: "Seed Shop", shop: "seedshop", name: "A", username: "a", password: "longpassword1" });
    assert.ok((await c.get("/products")).json.length > 0);
    const r = (await c.get("/accounting/reconciliation")).json;
    assert.ok(r.subledger_checks.every(x => x.ok), JSON.stringify(r.subledger_checks));
  } finally { p.kill(); }
});

test("front-end escaping neutralises markup", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(path.join(root, "public/app.js"), "utf8");
  const esc = new Function(src.match(/const esc=.*?;\n/s)[0] + "return esc;")();
  assert.equal(esc(`<img src=x onerror=alert(1)>'"&`), "&lt;img src=x onerror=alert(1)&gt;&#39;&quot;&amp;");
});

test("barcodes: optional, unique case-insensitively, kept on edit, visible to cashiers", async () => {
  const a = await admin.post("/products", { name: "Scan A", sku: "SCAN-A", barcode: " 6001234567890 ", price: 10, cost: 5, stock: 0 });
  assert.equal(a.status, 201);
  const find = async (c, id) => (await c.get("/products")).json.find(p => p.id === id);
  assert.equal((await find(admin, a.json.id)).barcode, "6001234567890", "barcode is trimmed and saved");
  assert.equal((await find(cashier, a.json.id)).barcode, "6001234567890", "cashiers receive barcodes for scanning");

  const dup = await admin.post("/products", { name: "Scan B", sku: "SCAN-B", barcode: "6001234567890", price: 10 });
  assert.equal(dup.status, 400); assert.match(dup.json.error, /barcode/i);
  assert.equal((await admin.post("/products", { name: "Scan C", sku: "SCAN-C", barcode: "abc-1", price: 1 })).status, 201);
  assert.equal((await admin.post("/products", { name: "Scan D", sku: "SCAN-D", barcode: "ABC-1", price: 1 })).status, 400, "barcode uniqueness ignores case");
  assert.equal((await admin.post("/products", { name: "No code 1", sku: "NC1", price: 1 })).status, 201);
  assert.equal((await admin.post("/products", { name: "No code 2", sku: "NC2", price: 1 })).status, 201, "products without a barcode never collide");
  const skuDup = await admin.post("/products", { name: "Same SKU", sku: "SCAN-A", price: 1 });
  assert.equal(skuDup.status, 400); assert.match(skuDup.json.error, /SKU/);
  assert.equal((await admin.post("/products", { name: "Long", sku: "LNG", barcode: "9".repeat(65), price: 1 })).status, 400);

  const cur = await find(admin, a.json.id), { barcode, ...withoutBarcode } = cur;
  assert.equal((await admin.put(`/products/${a.json.id}`, withoutBarcode)).status, 200);
  assert.equal((await find(admin, a.json.id)).barcode, "6001234567890", "editing without the field keeps the barcode");
  assert.equal((await admin.put(`/products/${a.json.id}`, { ...cur, barcode: "" })).status, 200);
  assert.equal((await find(admin, a.json.id)).barcode, null, "an empty barcode clears it");
});

test("receipt settings: readable by all, writable by admin/manager, validated", async () => {
  const d = (await cashier.get("/settings")).json;
  assert.ok(d.business_name && typeof d.receipt_footer === "string");
  assert.equal((await cashier.put("/settings", { business_name: "Hacked" })).status, 403);
  const up = await admin.put("/settings", { business_name: " Kofi Mart ", business_address: "Adum, Kumasi", receipt_footer: "" });
  assert.equal(up.status, 200); assert.equal(up.json.business_name, "Kofi Mart"); assert.equal(up.json.receipt_footer, "");
  const seen = (await cashier.get("/settings")).json;
  assert.equal(seen.business_name, "Kofi Mart"); assert.equal(seen.business_address, "Adum, Kumasi");
  assert.equal((await admin.put("/settings", { business_phone: "024 000 0000" })).json.business_name, "Kofi Mart", "partial update leaves other fields alone");
  assert.equal((await admin.put("/settings", { business_name: "  " })).status, 400);
  assert.equal((await admin.put("/settings", { business_name: "x".repeat(81) })).status, 400);
});

test("multi-tenant: shops are isolated, codes are unique, logins are per shop", async () => {
  const a = new Client(), b = new Client();
  assert.equal((await a.post("/auth/signup", { shop_name: "Shop Alpha", shop: "alpha", name: "A", username: "boss", password: "longpassword1" })).status, 201);
  assert.equal((await b.post("/auth/signup", { shop_name: "Shop Beta", shop: "beta", name: "B", username: "boss", password: "longpassword1" })).status, 201, "same username in another shop is fine");
  const dup = await new Client().post("/auth/signup", { shop_name: "Another Alpha", shop: "alpha", name: "X", username: "x", password: "longpassword1" });
  assert.equal(dup.status, 409);
  assert.equal((await new Client().post("/auth/signup", { shop_name: "Bad", shop: "AB", name: "X", username: "x", password: "longpassword1" })).status, 400, "code too short");
  assert.equal((await new Client().post("/auth/signup", { shop_name: "Bad", shop: "admin", name: "X", username: "x", password: "longpassword1" })).status, 400, "reserved code");
  assert.equal((await new Client().post("/auth/signup", { shop_name: "Weak", shop: "weakshop", name: "X", username: "x", password: "short" })).status, 400, "weak password");
  // Data written in Alpha is invisible in Beta and in the earlier test shop.
  assert.equal((await a.post("/products", { name: "Alpha Only", sku: "AL-1", price: 5, cost: 2, stock: 0 })).status, 201);
  assert.deepEqual((await b.get("/products")).json, [], "Beta sees nothing from Alpha");
  assert.ok(!(await admin.get("/products")).json.some(p => p.name === "Alpha Only"), "the first shop sees nothing from Alpha");
  assert.equal((await a.get("/settings")).json.business_name, "Shop Alpha");
  assert.equal((await b.get("/settings")).json.business_name, "Shop Beta");
  assert.equal((await a.get("/users")).json.length, 1, "staff lists are per shop");
  // Logging in needs the right shop code.
  assert.equal((await new Client().post("/auth/login", { shop: "alpha", username: "boss", password: "longpassword1" })).status, 200);
  assert.equal((await new Client().post("/auth/login", { username: "boss", password: "longpassword1" })).status, 401, "no shop code");
  assert.equal((await new Client().post("/auth/login", { shop: "nosuchshop", username: "boss", password: "longpassword1" })).status, 401);
  assert.equal((await new Client().post("/auth/login", { shop: "beta", username: "boss", password: "wrongpassword1" })).status, 401);
  // A session cannot be moved to another shop by changing the code in the cookie.
  const token = a.cookie.split("=")[1].split(".")[1], forged = new Client(); forged.cookie = `shopflow_session=beta.${token}`;
  assert.equal((await forged.get("/products")).status, 401, "token from Alpha is useless in Beta");
  assert.equal((await new Client().get("/products")).status, 401, "no session, no data");
  // Each shop has its own books that reconcile independently.
  assert.equal((await a.get("/accounting/reconciliation")).json.balanced, true);
  assert.equal((await b.get("/accounting/reconciliation")).json.balanced, true);
});

test("multi-tenant: a suspended shop is locked out and can be reactivated", async () => {
  const { default: Database } = await import("better-sqlite3");
  const g = new Client();
  assert.equal((await g.post("/auth/signup", { shop_name: "Gamma", shop: "gamma", name: "G", username: "gboss", password: "longpassword1" })).status, 201);
  assert.equal((await g.get("/products")).status, 200);
  const m = new Database(path.join(dir, "master.db"));
  try {
    m.prepare("UPDATE shops SET status='suspended' WHERE slug='gamma'").run();
    const blocked = await g.get("/products");
    assert.equal(blocked.status, 403); assert.match(blocked.json.error, /suspended/i);
    assert.equal((await new Client().post("/auth/login", { shop: "gamma", username: "gboss", password: "longpassword1" })).status, 403);
    assert.equal((await admin.get("/products")).status, 200, "other shops are unaffected");
    m.prepare("UPDATE shops SET status='active' WHERE slug='gamma'").run();
    assert.equal((await g.get("/products")).status, 200, "reactivated shop works again");
  } finally { m.close(); }
});

test("an existing single-shop database is adopted as shop 'main' with its data intact", async () => {
  const { copyFileSync, existsSync } = await import("node:fs");
  const d2 = mkdtempSync(path.join(tmpdir(), "shopflow-legacy-"));
  const legacyPath = path.join(d2, "shop.db"), port = PORT + 700;
  // Make a shop database with data in it, then use that file as if it were an old one-shop install.
  const p1 = await start({ DATABASE_PATH: path.join(d2, "build", "x.db") }, port, "unused.db");
  const c1 = new Client(`http://127.0.0.1:${port}/api`);
  await c1.post("/auth/signup", { shop_name: "Old Shop", shop: "oldshop", name: "O", username: "owner", password: "longpassword1" });
  await c1.post("/products", { name: "Legacy Item", sku: "LG-1", price: 3, cost: 1, stock: 0 });
  p1.kill(); await new Promise(r => setTimeout(r, 300));
  const built = path.join(d2, "build", "shops", "oldshop.db");
  for (const ext of ["", "-wal", "-shm"]) if (existsSync(built + ext)) copyFileSync(built + ext, legacyPath + ext);
  const p2 = await start({ DATABASE_PATH: legacyPath }, port + 1, "unused.db");
  try {
    const c2 = new Client(`http://127.0.0.1:${port + 1}/api`);
    assert.equal((await c2.post("/auth/login", { shop: "main", username: "owner", password: "longpassword1" })).status, 200);
    assert.ok((await c2.get("/products")).json.some(p => p.name === "Legacy Item"), "legacy data is intact");
    assert.equal((await c2.get("/settings")).json.business_name, "Old Shop");
  } finally { p2.kill(); rmSync(d2, { recursive: true, force: true }); }
});
