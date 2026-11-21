import express from "express";
import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";

const __dirname=path.dirname(fileURLToPath(import.meta.url));
const app=express(), PORT=process.env.PORT||3000;
if(process.env.NODE_ENV==="production")app.set("trust proxy",1);
// ---- Multi-tenant storage: a small master database lists the shops; every shop has its own SQLite file. ----
// Code below keeps using `db`; it is a proxy that resolves to the database of the shop handling the current request.
const DB_PATH=process.env.DATABASE_PATH||path.join(__dirname,"shop.db");
const DATA_DIR=process.env.DATA_DIR||path.dirname(DB_PATH);
const TENANT_DIR=path.join(DATA_DIR,"shops");
fs.mkdirSync(TENANT_DIR,{recursive:true});
const master=new Database(path.join(DATA_DIR,"master.db"));
master.pragma("journal_mode = WAL");
master.exec(`CREATE TABLE IF NOT EXISTS shops(id INTEGER PRIMARY KEY AUTOINCREMENT,slug TEXT UNIQUE NOT NULL,name TEXT NOT NULL,db_file TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended')),plan TEXT NOT NULL DEFAULT 'trial',trial_ends_at TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
const tenantStore=new AsyncLocalStorage();
const db=new Proxy({},{get(_,k){const s=tenantStore.getStore();if(!s)throw new Error("No shop is selected for this request.");const v=s.db[k];return typeof v==="function"?v.bind(s.db):v}});
const SLUG_RE=/^[a-z0-9][a-z0-9-]{2,29}$/,RESERVED_SLUGS=new Set(["admin","api","app","www","master","superadmin","support","login","signup","static","public","shopflow"]);
const shopFile=shop=>path.isAbsolute(shop.db_file)?shop.db_file:path.join(TENANT_DIR,shop.db_file);
const openShops=new Map(); // slug -> {db,slug,name}; least recently used closed beyond 100 open shops
function openShop(shop,{init=true}={}){
 let h=openShops.get(shop.slug);
 if(h){openShops.delete(shop.slug);openShops.set(shop.slug,h);return h}
 const d=new Database(shopFile(shop));d.pragma("journal_mode = WAL");d.pragma("foreign_keys = ON");
 h={db:d,slug:shop.slug,name:shop.name};
 if(init)tenantStore.run(h,()=>initTenantSchema());
 openShops.set(shop.slug,h);
 if(openShops.size>100){const [oldSlug,old]=openShops.entries().next().value;openShops.delete(oldSlug);try{old.db.close()}catch{}}
 return h;
}
const findShop=slug=>SLUG_RE.test(String(slug||""))?master.prepare("SELECT * FROM shops WHERE slug=?").get(String(slug)):undefined;
app.use(helmet({contentSecurityPolicy:false}));
app.use(express.json({limit:"1mb"}));
const safeDecode=v=>{try{return decodeURIComponent(v)}catch{return v}};
app.use((req,res,next)=>{const raw=req.headers.cookie||"";req.cookies=Object.fromEntries(raw.split(";").map(v=>v.trim()).filter(v=>v.includes("=")).map(v=>{const i=v.indexOf("=");return [safeDecode(v.slice(0,i)),safeDecode(v.slice(i+1))]}));next();});
app.use(express.static(path.join(__dirname,"public"),{etag:true,setHeaders:(res,f)=>{if(/\.(js|html|css)$/.test(f))res.setHeader("Cache-Control","no-cache")}}));
const loginLimiter=rateLimit({windowMs:15*60*1000,limit:10,skipSuccessfulRequests:true,standardHeaders:true,legacyHeaders:false,message:{error:"Too many login attempts. Try again later."}});
const now=()=>new Date().toISOString();
const hash=s=>crypto.createHash("sha256").update(s).digest("hex");
const scrypt=(password,salt)=>crypto.scryptSync(password,salt,64).toString("hex");
const accountId=code=>db.prepare('SELECT id FROM accounts WHERE code=?').get(code)?.id;
const tenderAccountCode=method=>method==='Mobile Money'?'1020':method==='Bank Transfer'?'1010':method==='Card'?'1030':method==='Store Credit'?'2200':'1000';
function postJournal({description,lines,sourceType=null,sourceId=null,entryDate=new Date().toISOString().slice(0,10),userId=null}){
 const dateText=String(entryDate||'');const dateParts=/^(\d{4})-(\d{2})-(\d{2})$/.exec(dateText);const dateObj=dateParts?new Date(Date.UTC(Number(dateParts[1]),Number(dateParts[2])-1,Number(dateParts[3]))):null;if(!Array.isArray(lines)||!dateParts||dateObj.getUTCFullYear()!==Number(dateParts[1])||dateObj.getUTCMonth()+1!==Number(dateParts[2])||dateObj.getUTCDate()!==Number(dateParts[3]))throw new Error('A valid journal date and journal lines are required.');
 const clean=lines.map(l=>{const rawDebit=Number(l.debit??0),rawCredit=Number(l.credit??0);if(!Number.isFinite(rawDebit)||!Number.isFinite(rawCredit))throw new Error('Journal amounts must be valid numbers.');return {account_id:Number(l.account_id||accountId(l.code)),description:l.description||description,debit:Math.round(rawDebit*100)/100,credit:Math.round(rawCredit*100)/100};}).filter(l=>l.debit>0||l.credit>0);
 if(clean.length<2||clean.some(l=>!l.account_id||l.debit<0||l.credit<0||((l.debit>0)===(l.credit>0))||!db.prepare('SELECT id FROM accounts WHERE id=? AND active=1').get(l.account_id)))throw new Error('Journal lines must each use an active account and contain either a positive debit or a positive credit.');
 const debit=Math.round(clean.reduce((n,l)=>n+l.debit,0)*100)/100,credit=Math.round(clean.reduce((n,l)=>n+l.credit,0)*100)/100;
 if(Math.abs(debit-credit)>0.005||debit<=0)throw new Error('Journal entry is not balanced. Total debits must equal total credits.');
 const entryNo='JE-'+Date.now().toString(36).toUpperCase()+'-'+crypto.randomBytes(2).toString('hex').toUpperCase();
 const ins=db.prepare('INSERT INTO journal_entries(entry_no,entry_date,description,source_type,source_id,created_by) VALUES(?,?,?,?,?,?)').run(entryNo,entryDate,description,sourceType,sourceId,userId);
 const lineIns=db.prepare('INSERT INTO journal_lines(entry_id,account_id,description,debit,credit) VALUES(?,?,?,?,?)');
 clean.forEach(l=>lineIns.run(ins.lastInsertRowid,l.account_id,l.description,l.debit,l.credit));
 return {id:ins.lastInsertRowid,entry_no:entryNo,total_debit:debit,total_credit:credit};
}
// Allocate a monetary total in cents without losing rounding cents.
function allocateMoney(total, weights){
 const cents=Math.round(Number(total||0)*100),sum=weights.reduce((a,b)=>a+Math.max(0,Number(b)||0),0);
 if(!weights.length)return [];if(sum<=0)return weights.map((_,i)=>i===weights.length-1?cents/100:0);
 let used=0;return weights.map((w,i)=>{const c=i===weights.length-1?cents-used:Math.round(cents*Math.max(0,Number(w)||0)/sum);used+=c;return c/100;});
}
const r2=n=>Math.round(n*100)/100;
const PAYMENT_METHODS=["Cash","Mobile Money","Bank Transfer","Card"];
const validQty=v=>{const n=Number(v);return Number.isFinite(n)?Math.floor(n):0};
// Cash that physically entered/left the drawer for one shift: cash tendered on sales, later cash receipts, and cash refunds.
function shiftCash(shiftId){
 const sales=db.prepare("SELECT COALESCE(SUM(CASE WHEN tender_method IS NULL THEN (CASE WHEN payment_method='Cash' THEN total ELSE 0 END) WHEN tender_method='Cash' THEN MIN(initial_paid,total) ELSE 0 END),0) cash_sales,COUNT(*) transactions FROM sales WHERE shift_id=?").get(shiftId);
 const receipts=db.prepare("SELECT COALESCE(SUM(amount),0) n FROM customer_payments WHERE shift_id=? AND method='Cash'").get(shiftId).n;
 const refunds=db.prepare("SELECT COALESCE(SUM(r.total-r.receivable_offset),0) n FROM returns r LEFT JOIN sales s ON s.id=r.sale_id WHERE r.refund_method='Cash' AND COALESCE(r.shift_id,s.shift_id)=?").get(shiftId).n;
 return {cash_sales:r2(sales.cash_sales),cash_receipts:r2(receipts),cash_refunds:r2(refunds),transactions:sales.transactions};
}
function ledgerBalances(){const rows=db.prepare("SELECT a.code,ROUND(COALESCE(SUM(l.debit-l.credit),0),2) signed FROM accounts a LEFT JOIN journal_lines l ON l.account_id=a.id GROUP BY a.id").all();return code=>Number(rows.find(a=>a.code===code)?.signed||0);}
// Safe schema upgrades for databases created by earlier SHOPFLOW versions.
const ensureColumn=(table,col,ddl)=>{if(!db.prepare(`PRAGMA table_info(${table})`).all().some(c=>c.name===col))db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`)};
const cleanBarcode=v=>{const b=String(v??"").trim();return b||null};
function initTenantSchema(){
db.exec(`
CREATE TABLE IF NOT EXISTS products(id INTEGER PRIMARY KEY AUTOINCREMENT,sku TEXT UNIQUE,name TEXT NOT NULL,category TEXT DEFAULT 'General',price REAL NOT NULL DEFAULT 0,cost REAL NOT NULL DEFAULT 0,stock INTEGER NOT NULL DEFAULT 0,reorder_level INTEGER NOT NULL DEFAULT 5,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS sales(id INTEGER PRIMARY KEY AUTOINCREMENT,receipt_no TEXT UNIQUE,subtotal REAL NOT NULL,discount REAL DEFAULT 0,tax REAL DEFAULT 0,total REAL NOT NULL,payment_method TEXT NOT NULL,amount_paid REAL NOT NULL,change_due REAL DEFAULT 0,cashier TEXT DEFAULT 'Admin',created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS sale_items(id INTEGER PRIMARY KEY AUTOINCREMENT,sale_id INTEGER NOT NULL REFERENCES sales(id),product_id INTEGER,product_name TEXT NOT NULL,quantity INTEGER NOT NULL,unit_price REAL NOT NULL,line_total REAL NOT NULL,discount_amount REAL NOT NULL DEFAULT 0,tax_amount REAL NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS expenses(id INTEGER PRIMARY KEY AUTOINCREMENT,title TEXT NOT NULL,category TEXT DEFAULT 'General',amount REAL NOT NULL,note TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS customers(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,phone TEXT,email TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS suppliers(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,phone TEXT,email TEXT,address TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,username TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL,salt TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('admin','manager','cashier')),active INTEGER NOT NULL DEFAULT 1,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,expires_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS purchases(id INTEGER PRIMARY KEY AUTOINCREMENT,purchase_no TEXT UNIQUE,supplier_id INTEGER REFERENCES suppliers(id),supplier_name TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'received',subtotal REAL NOT NULL,total REAL NOT NULL,notes TEXT,created_by TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS purchase_items(id INTEGER PRIMARY KEY AUTOINCREMENT,purchase_id INTEGER NOT NULL REFERENCES purchases(id),product_id INTEGER REFERENCES products(id),product_name TEXT NOT NULL,quantity INTEGER NOT NULL,unit_cost REAL NOT NULL,line_total REAL NOT NULL);
CREATE TABLE IF NOT EXISTS returns(id INTEGER PRIMARY KEY AUTOINCREMENT,return_no TEXT UNIQUE,sale_id INTEGER REFERENCES sales(id),reason TEXT NOT NULL,refund_method TEXT NOT NULL,total REAL NOT NULL,processed_by TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS return_items(id INTEGER PRIMARY KEY AUTOINCREMENT,return_id INTEGER NOT NULL REFERENCES returns(id),product_id INTEGER,product_name TEXT NOT NULL,quantity INTEGER NOT NULL,unit_price REAL NOT NULL,line_total REAL NOT NULL,discount_amount REAL NOT NULL DEFAULT 0,tax_amount REAL NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS inventory_movements(id INTEGER PRIMARY KEY AUTOINCREMENT,product_id INTEGER,product_name TEXT NOT NULL,movement_type TEXT NOT NULL,quantity_change INTEGER NOT NULL,stock_after INTEGER NOT NULL,reference TEXT,note TEXT,created_by TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS shifts(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL REFERENCES users(id),cashier_name TEXT NOT NULL,opening_cash REAL NOT NULL,closing_cash REAL,expected_cash REAL,cash_difference REAL,status TEXT NOT NULL DEFAULT 'open',opened_at TEXT DEFAULT CURRENT_TIMESTAMP,closed_at TEXT);
CREATE TABLE IF NOT EXISTS customer_payments(id INTEGER PRIMARY KEY AUTOINCREMENT,customer_id INTEGER NOT NULL REFERENCES customers(id),sale_id INTEGER REFERENCES sales(id),amount REAL NOT NULL,method TEXT NOT NULL DEFAULT 'Cash',note TEXT,received_by TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS supplier_payments(id INTEGER PRIMARY KEY AUTOINCREMENT,supplier_id INTEGER NOT NULL REFERENCES suppliers(id),purchase_id INTEGER REFERENCES purchases(id),amount REAL NOT NULL,method TEXT NOT NULL DEFAULT 'Cash',note TEXT,paid_by TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS purchase_orders(id INTEGER PRIMARY KEY AUTOINCREMENT,order_no TEXT UNIQUE,supplier_id INTEGER NOT NULL REFERENCES suppliers(id),supplier_name TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'ordered',notes TEXT,created_by TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS purchase_order_items(id INTEGER PRIMARY KEY AUTOINCREMENT,order_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,product_id INTEGER NOT NULL REFERENCES products(id),product_name TEXT NOT NULL,ordered_qty INTEGER NOT NULL,received_qty INTEGER NOT NULL DEFAULT 0,unit_cost REAL NOT NULL);
CREATE TABLE IF NOT EXISTS stock_transfers(id INTEGER PRIMARY KEY AUTOINCREMENT,transfer_no TEXT UNIQUE,from_location TEXT NOT NULL,to_location TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'completed',note TEXT,created_by TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS stock_transfer_items(id INTEGER PRIMARY KEY AUTOINCREMENT,transfer_id INTEGER NOT NULL REFERENCES stock_transfers(id),product_id INTEGER NOT NULL REFERENCES products(id),product_name TEXT NOT NULL,quantity INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS stocktakes(id INTEGER PRIMARY KEY AUTOINCREMENT,stocktake_no TEXT UNIQUE,note TEXT,created_by TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS stocktake_items(id INTEGER PRIMARY KEY AUTOINCREMENT,stocktake_id INTEGER NOT NULL REFERENCES stocktakes(id),product_id INTEGER NOT NULL REFERENCES products(id),product_name TEXT NOT NULL,system_qty INTEGER NOT NULL,counted_qty INTEGER NOT NULL,variance INTEGER NOT NULL);
`);

// MILESTONE 6: double-entry accounting foundation.
db.exec(`
CREATE TABLE IF NOT EXISTS accounts(
 id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
 type TEXT NOT NULL CHECK(type IN ('asset','liability','equity','income','expense')),
 normal_balance TEXT NOT NULL CHECK(normal_balance IN ('debit','credit')),
 active INTEGER NOT NULL DEFAULT 1, system_account INTEGER NOT NULL DEFAULT 0,
 created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS journal_entries(
 id INTEGER PRIMARY KEY AUTOINCREMENT, entry_no TEXT NOT NULL UNIQUE,
 entry_date TEXT NOT NULL, description TEXT NOT NULL, source_type TEXT,
 source_id INTEGER, status TEXT NOT NULL DEFAULT 'posted' CHECK(status IN ('posted','reversed')),
 created_by INTEGER REFERENCES users(id), created_at TEXT DEFAULT CURRENT_TIMESTAMP,
 reversed_by INTEGER REFERENCES users(id), reversed_at TEXT, reversal_of INTEGER REFERENCES journal_entries(id)
);
CREATE TABLE IF NOT EXISTS journal_lines(
 id INTEGER PRIMARY KEY AUTOINCREMENT, entry_id INTEGER NOT NULL REFERENCES journal_entries(id),
 account_id INTEGER NOT NULL REFERENCES accounts(id), description TEXT,
 debit REAL NOT NULL DEFAULT 0 CHECK(debit>=0), credit REAL NOT NULL DEFAULT 0 CHECK(credit>=0),
 CHECK((debit>0 AND credit=0) OR (credit>0 AND debit=0))
);
CREATE INDEX IF NOT EXISTS idx_journal_entries_date ON journal_entries(entry_date,id);
CREATE INDEX IF NOT EXISTS idx_journal_lines_account ON journal_lines(account_id,entry_id);
`);
const defaultAccounts=[
 ['1000','Cash on Hand','asset','debit'],['1010','Bank','asset','debit'],['1020','Mobile Money','asset','debit'],['1030','Card Clearing','asset','debit'],
 ['1100','Accounts Receivable','asset','debit'],['1200','Inventory','asset','debit'],
 ['2000','Accounts Payable','liability','credit'],['2100','Tax Payable','liability','credit'],['2200','Store Credit Liability','liability','credit'],
 ['3000','Owner Equity','equity','credit'],['3100','Retained Earnings','equity','credit'],
 ['4000','Sales Revenue','income','credit'],['4100','Sales Returns','income','debit'],
 ['5000','Cost of Goods Sold','expense','debit'],['5100','Operating Expenses','expense','debit'],['5200','Inventory Adjustments','expense','debit']
];
const seedAccount=db.prepare('INSERT OR IGNORE INTO accounts(code,name,type,normal_balance,system_account) VALUES(?,?,?,?,1)');
for(const a of defaultAccounts)seedAccount.run(...a);
// Barcode is separate from SKU so a printed barcode can be scanned without renaming internal codes.
ensureColumn("products","barcode","TEXT");
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode COLLATE NOCASE) WHERE barcode IS NOT NULL");
db.exec("CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
const salesColumns=db.prepare("PRAGMA table_info(sales)").all().map(x=>x.name);
if(!salesColumns.includes('shift_id')) db.exec('ALTER TABLE sales ADD COLUMN shift_id INTEGER REFERENCES shifts(id)');
if(!salesColumns.includes('customer_id')) db.exec('ALTER TABLE sales ADD COLUMN customer_id INTEGER REFERENCES customers(id)');
if(!salesColumns.includes('amount_received')) db.exec('ALTER TABLE sales ADD COLUMN amount_received REAL NOT NULL DEFAULT 0');
if(!salesColumns.includes('balance_due')) db.exec('ALTER TABLE sales ADD COLUMN balance_due REAL NOT NULL DEFAULT 0');
db.exec('UPDATE sales SET amount_received=amount_paid WHERE amount_received=0 AND amount_paid>0');
const saleItemColumns=db.prepare('PRAGMA table_info(sale_items)').all().map(x=>x.name);
if(!saleItemColumns.includes('cost_price'))db.exec('ALTER TABLE sale_items ADD COLUMN cost_price REAL NOT NULL DEFAULT 0');
if(!saleItemColumns.includes('discount_amount'))db.exec('ALTER TABLE sale_items ADD COLUMN discount_amount REAL NOT NULL DEFAULT 0');
if(!saleItemColumns.includes('tax_amount'))db.exec('ALTER TABLE sale_items ADD COLUMN tax_amount REAL NOT NULL DEFAULT 0');
const returnItemColumns=db.prepare('PRAGMA table_info(return_items)').all().map(x=>x.name);
if(!returnItemColumns.includes('discount_amount'))db.exec('ALTER TABLE return_items ADD COLUMN discount_amount REAL NOT NULL DEFAULT 0');
if(!returnItemColumns.includes('tax_amount'))db.exec('ALTER TABLE return_items ADD COLUMN tax_amount REAL NOT NULL DEFAULT 0');
const hadCostSnapshot=db.prepare('PRAGMA table_info(sale_items)').all().some(c=>c.name==='cost_snapshot');
ensureColumn('sale_items','cost_snapshot','INTEGER NOT NULL DEFAULT 0');
if(!hadCostSnapshot)db.exec('UPDATE sale_items SET cost_snapshot=1 WHERE cost_price>0');
ensureColumn('sales','tender_method','TEXT');
ensureColumn('sales','initial_paid','REAL NOT NULL DEFAULT 0');
ensureColumn('returns','receivable_offset','REAL NOT NULL DEFAULT 0');
ensureColumn('returns','shift_id','INTEGER REFERENCES shifts(id)');
ensureColumn('customer_payments','shift_id','INTEGER REFERENCES shifts(id)');
// Backfill legacy sale-line allocations from original sale totals; preserve exact cents across each sale.
const legacySales=db.prepare(`SELECT s.* FROM sales s WHERE EXISTS(SELECT 1 FROM sale_items si WHERE si.sale_id=s.id AND si.discount_amount=0 AND si.tax_amount=0) AND (s.discount>0 OR s.tax>0)`).all();
const legacyLineQuery=db.prepare('SELECT * FROM sale_items WHERE sale_id=? ORDER BY id');
const legacyUpdate=db.prepare('UPDATE sale_items SET discount_amount=?,tax_amount=? WHERE id=?');
for(const saleRow of legacySales){const saleLines=legacyLineQuery.all(saleRow.id),gross=saleLines.map(x=>Number(x.line_total)||0),discounts=allocateMoney(saleRow.discount,gross),net=gross.map((v,i)=>Math.max(0,v-discounts[i])),taxes=allocateMoney(saleRow.tax,net);saleLines.forEach((line,i)=>legacyUpdate.run(discounts[i],taxes[i],line.id));}
// Legacy sales cannot be reliably re-costed from today's product cost; only new sales store an exact cost snapshot.
db.exec(`CREATE TABLE IF NOT EXISTS accounting_controls(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at TEXT DEFAULT CURRENT_TIMESTAMP); CREATE TABLE IF NOT EXISTS store_credit_transactions(id INTEGER PRIMARY KEY AUTOINCREMENT,customer_id INTEGER NOT NULL REFERENCES customers(id),sale_id INTEGER REFERENCES sales(id),return_id INTEGER REFERENCES returns(id),transaction_type TEXT NOT NULL CHECK(transaction_type IN ('issued','redeemed')),amount REAL NOT NULL CHECK(amount>0),created_by TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
const purchaseColumns=db.prepare("PRAGMA table_info(purchases)").all().map(x=>x.name);
if(!purchaseColumns.includes('amount_paid')) db.exec('ALTER TABLE purchases ADD COLUMN amount_paid REAL NOT NULL DEFAULT 0');
if(!purchaseColumns.includes('balance_due')) db.exec('ALTER TABLE purchases ADD COLUMN balance_due REAL NOT NULL DEFAULT 0');
const productCount=db.prepare("SELECT COUNT(*) n FROM products").get().n;
if(!productCount&&process.env.SEED_DEMO_DATA==="true"){const ins=db.prepare("INSERT INTO products(sku,name,category,price,cost,stock,reorder_level) VALUES(?,?,?,?,?,?,?)");[["SKU-1001","Premium Rice 5kg","Groceries",95,76,42,8],["SKU-1002","Cooking Oil 1L","Groceries",32,24,65,12],["SKU-1003","Powdered Milk 400g","Dairy",48,38,28,6],["SKU-1004","Bathing Soap","Personal Care",12,8,110,20],["SKU-1005","Bottled Water 1.5L","Beverages",8,5,96,24],["SKU-1006","Laundry Detergent","Home Care",35,27,19,8],["SKU-1007","Tomato Paste","Groceries",10,7,54,12],["SKU-1008","Biscuits Family Pack","Snacks",18,12,37,10]].forEach(x=>ins.run(...x));
 const seeded=db.prepare("SELECT id,name,stock,cost FROM products").all(),mvSeed=db.prepare("INSERT INTO inventory_movements(product_id,product_name,movement_type,quantity_change,stock_after,reference,note,created_by) VALUES(?,?,?,?,?,?,?,?)");
 seeded.forEach(p=>mvSeed.run(p.id,p.name,'opening_stock',p.stock,p.stock,'SEED','Demo opening stock','system'));
 const seedValue=r2(seeded.reduce((n,p)=>n+p.stock*p.cost,0));if(seedValue>0)postJournal({description:'Demo opening stock',sourceType:'opening_stock',sourceId:0,lines:[{code:'1200',debit:seedValue},{code:'3000',credit:seedValue}]});}
}
const usersCount=()=>db.prepare("SELECT COUNT(*) n FROM users").get().n;
// A session cookie looks like "<shop-code>.<token>", so every request knows which shop's database to use.
const splitSession=raw=>{raw=String(raw||"");const i=raw.indexOf(".");return i>0?{slug:raw.slice(0,i),token:raw.slice(i+1)}:{slug:"",token:""}};
const sessionRaw=req=>req.cookies?.shopflow_session||req.headers["x-session-token"]||"";
function currentUser(req,res,next){const {token}=splitSession(sessionRaw(req));if(!token)return res.status(401).json({error:"Please sign in."});const row=db.prepare("SELECT u.id,u.name,u.username,u.role,u.active,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?").get(hash(token));if(!row||!row.active||new Date(row.expires_at)<new Date()){db.prepare("DELETE FROM sessions WHERE token_hash=?").run(hash(token));return res.status(401).json({error:"Your session has expired. Sign in again."});}req.user=row;next();}
const roles=(...allowed)=>(req,res,next)=>allowed.includes(req.user.role)?next():res.status(403).json({error:"You do not have permission to perform this action."});
const SUSPENDED_MSG="This shop's account is suspended. Please contact support.";
// Every /api request runs inside exactly one shop's database. The shop comes from the session cookie (or, for login, from the shop code that was typed).
app.use("/api",(req,res,next)=>{
 if(req.path==="/auth/signup"||req.path==="/auth/status")return next();
 const isLogin=req.path==="/auth/login";
 const slug=isLogin?String(req.body?.shop||"").trim().toLowerCase():splitSession(sessionRaw(req)).slug;
 const shop=findShop(slug);
 if(!shop)return res.status(401).json({error:isLogin?"Incorrect shop code, username or password.":"Please sign in."});
 if(shop.status!=="active")return res.status(403).json({error:SUSPENDED_MSG});
 let handle;try{handle=openShop(shop)}catch(e){console.error(e);return res.status(500).json({error:"This shop could not be opened. Please try again."})}
 tenantStore.run(handle,()=>{if(isLogin)return next();currentUser(req,res,next)});
});
app.get("/api/auth/status",(req,res)=>{const shop=findShop(splitSession(sessionRaw(req)).slug);res.json({setupRequired:false,multiTenant:true,signedInShop:shop&&shop.status==="active"?{code:shop.slug,name:shop.name}:null})});
const signupLimiter=rateLimit({windowMs:60*60*1000,limit:10,standardHeaders:true,legacyHeaders:false,message:{error:"Too many sign-ups from this connection. Try again later."}});
const slugFromName=n=>String(n||"").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"").slice(0,30).replace(/-+$/,"");
// Create a new shop: registers it, builds its database, creates its first administrator and starts a 14-day trial.
app.post("/api/auth/signup",signupLimiter,(req,res)=>{
 const b=req.body||{},shopName=String(b.shop_name||"").trim(),name=String(b.name||"").trim(),username=String(b.username||"").trim().toLowerCase(),password=String(b.password||"");
 const slug=String(b.shop||slugFromName(shopName)).trim().toLowerCase();
 if(shopName.length<2||shopName.length>80)return res.status(400).json({error:"Enter your shop name (2 to 80 characters)."});
 if(!SLUG_RE.test(slug)||RESERVED_SLUGS.has(slug))return res.status(400).json({error:"The shop code must be 3 to 30 characters: lowercase letters, numbers and hyphens, starting with a letter or number."});
 if(!name||!username||password.length<10)return res.status(400).json({error:"Provide your name, a username and a password of at least 10 characters."});
 const file=`${slug}.db`,trialEnds=new Date(Date.now()+14*86400000).toISOString();
 try{master.prepare("INSERT INTO shops(slug,name,db_file,trial_ends_at) VALUES(?,?,?,?)").run(slug,shopName,file,trialEnds)}
 catch(e){if(/UNIQUE/.test(e.message))return res.status(409).json({error:"That shop code is already taken. Choose another."});throw e}
 try{
  const handle=openShop(findShop(slug));
  tenantStore.run(handle,()=>{
   const salt=crypto.randomBytes(16).toString("hex");
   const info=db.prepare("INSERT INTO users(name,username,password_hash,salt,role) VALUES(?,?,?,?,?)").run(name,username,scrypt(password,salt),salt,"admin");
   db.prepare("INSERT INTO settings(key,value) VALUES('business_name',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(shopName);
   createSession(res,info.lastInsertRowid);
  });
  res.status(201).json({ok:true,shop:slug});
 }catch(e){
  // Roll back a half-created shop so the code can be used again.
  console.error(e);const h=openShops.get(slug);if(h){openShops.delete(slug);try{h.db.close()}catch{}}
  master.prepare("DELETE FROM shops WHERE slug=?").run(slug);
  for(const ext of ["","-wal","-shm"])try{fs.rmSync(path.join(TENANT_DIR,file+ext),{force:true})}catch{}
  res.status(500).json({error:"The shop could not be created. Please try again."});
 }
});
function createSession(res,userId){const token=crypto.randomBytes(32).toString("hex"),expires=new Date(Date.now()+12*60*60*1000).toISOString(),slug=tenantStore.getStore().slug;db.prepare("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)").run(hash(token),userId,expires);res.cookie("shopflow_session",`${slug}.${token}`,{httpOnly:true,sameSite:"lax",secure:process.env.NODE_ENV==="production",maxAge:12*60*60*1000,path:"/"});}
app.post("/api/auth/login",loginLimiter,(req,res)=>{const {username,password}=req.body;const u=db.prepare("SELECT * FROM users WHERE username=?").get(String(username||"").toLowerCase());if(!u||!u.active||scrypt(String(password||""),u.salt)!==u.password_hash)return res.status(401).json({error:"Incorrect shop code, username or password."});createSession(res,u.id);res.json({ok:true});});
app.get("/api/auth/me",(req,res)=>res.json({id:req.user.id,name:req.user.name,username:req.user.username,role:req.user.role}));
app.post("/api/auth/logout",(req,res)=>{const {token}=splitSession(sessionRaw(req));if(token)db.prepare("DELETE FROM sessions WHERE token_hash=?").run(hash(token));res.clearCookie("shopflow_session",{httpOnly:true,sameSite:"lax",secure:process.env.NODE_ENV==="production",path:"/"});res.json({ok:true});});
app.get("/api/users",(req,res)=>{if(req.user.role!=="admin")return res.status(403).json({error:"Administrator access required."});res.json(db.prepare("SELECT id,name,username,role,active,created_at FROM users ORDER BY id").all());});
app.post("/api/users",roles("admin"),(req,res)=>{const {name,username,password,role}=req.body;if(!name||!username||!password||password.length<10||!["admin","manager","cashier"].includes(role))return res.status(400).json({error:"Complete all fields. Password must be at least 10 characters."});const salt=crypto.randomBytes(16).toString("hex");try{const x=db.prepare("INSERT INTO users(name,username,password_hash,salt,role) VALUES(?,?,?,?,?)").run(name,username.toLowerCase(),scrypt(password,salt),salt,role);res.status(201).json({id:x.lastInsertRowid});}catch(e){res.status(400).json({error:"Username already exists."});}});
app.patch("/api/users/:id",roles("admin"),(req,res)=>{
 const target=db.prepare("SELECT * FROM users WHERE id=?").get(req.params.id);if(!target)return res.status(404).json({error:"User not found."});
 const role=req.body.role===undefined?target.role:req.body.role,active=req.body.active===undefined?!!target.active:!!req.body.active;
 if(!["admin","manager","cashier"].includes(role))return res.status(400).json({error:"Invalid role."});
 if(target.id===req.user.id&&!active)return res.status(400).json({error:"You cannot deactivate your own account."});
 if(target.role==="admin"&&target.active&&(role!=="admin"||!active)){const others=db.prepare("SELECT COUNT(*) n FROM users WHERE role='admin' AND active=1 AND id<>?").get(target.id).n;if(!others)return res.status(400).json({error:"At least one active administrator is required."});}
 db.transaction(()=>{db.prepare("UPDATE users SET active=?,role=? WHERE id=?").run(active?1:0,role,target.id);if(!active)db.prepare("DELETE FROM sessions WHERE user_id=?").run(target.id);})();
 res.json({updated:1});
});
app.get("/api/summary",(req,res)=>{const today=db.prepare("SELECT COALESCE(SUM(total),0) total,COUNT(*) orders FROM sales WHERE date(created_at)=date('now','localtime')").get(),all=db.prepare("SELECT COALESCE(SUM(total),0)-(SELECT COALESCE(SUM(total),0) FROM returns) revenue,COUNT(*) orders FROM sales").get(),inventory=db.prepare("SELECT COUNT(*) products,COALESCE(SUM(stock),0) units,COALESCE(SUM(stock*cost),0) stock_value FROM products").get(),low=db.prepare("SELECT COUNT(*) n FROM products WHERE stock<=reorder_level").get().n,expenses=db.prepare("SELECT COALESCE(SUM(amount),0) amount FROM expenses WHERE date(created_at)=date('now','localtime')").get().amount,recent=db.prepare("SELECT id,receipt_no,total,payment_method,created_at FROM sales ORDER BY id DESC LIMIT 6").all(),chart=db.prepare("SELECT strftime('%d %b',created_at) day,SUM(total) total FROM sales WHERE created_at>=datetime('now','-6 days','localtime') GROUP BY date(created_at) ORDER BY date(created_at)").all();res.json({today,all,inventory,low,expenses,recent,chart});});
app.get("/api/products",(req,res)=>{const rows=db.prepare("SELECT * FROM products ORDER BY name").all();res.json(req.user.role==="cashier"?rows.map(({cost,...r})=>r):rows);});
app.post("/api/products",roles("admin","manager"),(req,res)=>{
 const p=req.body,name=String(p.name||"").trim(),price=Number(p.price),cost=Number(p.cost||0),stock=Number(p.stock||0),reorder=Number(p.reorder_level??5),barcode=cleanBarcode(p.barcode);
 if(barcode&&barcode.length>64)return res.status(400).json({error:"Barcode must be 64 characters or fewer."});
 if(!name||!Number.isFinite(price)||price<0||!Number.isFinite(cost)||cost<0||!Number.isInteger(stock)||stock<0||!Number.isInteger(reorder)||reorder<0)return res.status(400).json({error:"Enter a product name, a valid selling price, a non-negative cost, and whole-number stock and reorder level."});
 try{const id=db.transaction(()=>{const x=db.prepare("INSERT INTO products(sku,name,category,price,cost,stock,reorder_level,barcode) VALUES(?,?,?,?,?,?,?,?)").run(String(p.sku||"").trim()||`SKU-${Date.now()}`,name,String(p.category||"").trim()||"General",price,cost,stock,reorder,barcode);
  if(stock>0){db.prepare("INSERT INTO inventory_movements(product_id,product_name,movement_type,quantity_change,stock_after,reference,note,created_by) VALUES(?,?,?,?,?,?,?,?)").run(x.lastInsertRowid,name,"opening_stock",stock,stock,"NEW-PRODUCT","Initial stock entered when the product was created",req.user.name);
   const value=r2(stock*cost);if(value>0)postJournal({description:`Opening stock: ${name}`,sourceType:"opening_stock",sourceId:x.lastInsertRowid,lines:[{code:"1200",debit:value},{code:"3000",credit:value}],userId:req.user.id});}
  return x.lastInsertRowid;})();res.status(201).json({id});}catch(e){res.status(400).json({error:/UNIQUE/.test(e.message)?(/barcode/i.test(e.message)?"Barcode already belongs to another product.":"SKU already exists."):e.message});}
});
app.put("/api/products/:id",roles("admin","manager"),(req,res)=>{
 const p=req.body,cur=db.prepare("SELECT * FROM products WHERE id=?").get(req.params.id);if(!cur)return res.status(404).json({error:"Product not found."});
 const name=String(p.name||"").trim(),price=Number(p.price),reorder=Number(p.reorder_level);
 if(!name||!Number.isFinite(price)||price<0||!Number.isInteger(reorder)||reorder<0)return res.status(400).json({error:"Enter a product name, a valid selling price and a whole-number reorder level."});
 if(p.stock!==undefined&&Number(p.stock)!==cur.stock)return res.status(400).json({error:"Stock quantity cannot be edited here. Use Inventory Control (stocktake / adjust stock) or receive a purchase so the change is audited and journaled."});
 const barcode=p.barcode===undefined?cur.barcode:cleanBarcode(p.barcode);if(barcode&&barcode.length>64)return res.status(400).json({error:"Barcode must be 64 characters or fewer."});
 const newCost=p.cost===undefined?cur.cost:Number(p.cost);if(!Number.isFinite(newCost)||newCost<0)return res.status(400).json({error:"Enter a valid cost."});
 if(cur.stock>0&&Math.abs(newCost-cur.cost)>0.005)return res.status(400).json({error:"Cost of a product with stock on hand comes from purchase receipts (weighted average) and cannot be edited directly."});
 try{const x=db.prepare("UPDATE products SET sku=?,name=?,category=?,price=?,cost=?,reorder_level=?,barcode=? WHERE id=?").run(String(p.sku||cur.sku),name,String(p.category||"").trim()||"General",price,cur.stock>0?cur.cost:newCost,reorder,barcode,cur.id);res.json({updated:x.changes});}catch(e){res.status(400).json({error:/UNIQUE/.test(e.message)?(/barcode/i.test(e.message)?"Barcode already belongs to another product.":"SKU already exists."):e.message});}
});
// Business profile used on receipts. Paper width is a per-device browser setting, not stored here.
const SETTING_LIMITS={business_name:80,business_address:160,business_phone:40,receipt_footer:160};
const getSettings=()=>{const r=Object.fromEntries(db.prepare("SELECT key,value FROM settings").all().map(x=>[x.key,x.value]));return {business_name:r.business_name||process.env.BUSINESS_NAME||"My Shop",business_address:r.business_address??"",business_phone:r.business_phone??"",receipt_footer:r.receipt_footer??"Thank you for shopping with us!"}};
app.get("/api/settings",(req,res)=>res.json(getSettings()));
app.put("/api/settings",roles("admin","manager"),(req,res)=>{
 const b=req.body||{},up=[];
 for(const [k,max] of Object.entries(SETTING_LIMITS)){if(b[k]===undefined)continue;const v=String(b[k]).trim();
  if(v.length>max)return res.status(400).json({error:`${k.replace(/_/g," ")} must be ${max} characters or fewer.`});
  if(k==="business_name"&&!v)return res.status(400).json({error:"Business name is required."});
  up.push([k,v]);}
 const st=db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
 db.transaction(()=>up.forEach(([k,v])=>st.run(k,v)))();
 res.json(getSettings());
});
app.delete("/api/products/:id",roles("admin","manager"),(req,res)=>{
 const p=db.prepare("SELECT * FROM products WHERE id=?").get(req.params.id);if(!p)return res.status(404).json({error:"Product not found."});
 if(p.stock>0)return res.status(400).json({error:"Product still has stock on hand. Adjust stock to zero first."});
 try{res.json({deleted:db.prepare("DELETE FROM products WHERE id=?").run(p.id).changes});}catch(e){res.status(409).json({error:"This product has purchase, order or stock history and cannot be deleted."});}
});
app.get("/api/sales",(req,res)=>res.json(db.prepare("SELECT * FROM sales ORDER BY id DESC LIMIT 300").all()));
app.post("/api/sales",roles("admin","manager","cashier"),(req,res)=>{
 const {items,discount=0,tax=0,payment_method="Cash",tender_method="Cash",amount_paid,cashier,customer_id=null}=req.body;
 if(!Array.isArray(items)||!items.length)return res.status(400).json({error:"The cart is empty."});
 let subtotal=0,checked=[];const saleProductIds=new Set();
 for(const i of items){if(saleProductIds.has(Number(i.product_id)))return res.status(400).json({error:"Add each product only once to the sale cart."});saleProductIds.add(Number(i.product_id));const p=db.prepare("SELECT * FROM products WHERE id=?").get(i.product_id),q=validQty(i.quantity);if(!p||q<1)return res.status(400).json({error:"Invalid product or quantity."});if(p.stock<q)return res.status(400).json({error:`Insufficient stock for ${p.name}.`});checked.push({p,q,line:p.price*q});subtotal+=p.price*q;}
 subtotal=r2(subtotal);const d=r2(Math.max(0,Math.min(+discount||0,subtotal))),t=r2(Math.max(0,+tax||0)),total=r2(Math.max(0,subtotal-d+t)),tendered=Number(amount_paid);
 if(!Number.isFinite(tendered)||tendered<0||(tendered>total+0.00001&&payment_method!=="Cash"))return res.status(400).json({error:"Enter a valid amount received between zero and the sale total. Only Cash sales may be overpaid (change is returned)."});
 const paid=r2(Math.min(tendered,total));
 const balance=r2(Math.max(0,total-paid));
 if(payment_method==="Credit"&&paid>0)return res.status(400).json({error:"For a payment with an amount received, choose Part payment and specify the tender method."});
 const tenderMethod=payment_method==="Part payment"?String(tender_method):payment_method==="Credit"?"Cash":payment_method;
 if(!["Cash","Mobile Money","Bank Transfer","Card","Store Credit"].includes(tenderMethod))return res.status(400).json({error:"Select a valid tender method."});
 if((balance>0||tenderMethod==="Store Credit")&&!customer_id)return res.status(400).json({error:"Select a customer for credit or store-credit payment."});
 const customer=customer_id?db.prepare("SELECT * FROM customers WHERE id=?").get(customer_id):null;
 if(customer_id&&!customer)return res.status(400).json({error:"Selected customer was not found."});
 if(balance>0&&payment_method!=="Credit"&&payment_method!=="Part payment")return res.status(400).json({error:"Choose Credit or Part payment when an amount remains outstanding."});
 const discounts=allocateMoney(d,checked.map(x=>x.line)),netLines=checked.map((x,i)=>Math.max(0,x.line-discounts[i])),taxes=allocateMoney(t,netLines);checked=checked.map((x,i)=>({...x,discountAmount:discounts[i],taxAmount:taxes[i]}));
 const receipt="RCPT-"+Date.now().toString(36).toUpperCase()+"-"+crypto.randomBytes(2).toString("hex").toUpperCase();
 const activeShift=db.prepare("SELECT id FROM shifts WHERE user_id=? AND status='open' ORDER BY id DESC LIMIT 1").get(req.user.id);
 const tx=db.transaction(()=>{
  // Check and consume store credit inside the same write transaction to prevent concurrent overspending.
  if(tenderMethod==="Store Credit"){
   const available=Number(db.prepare("SELECT COALESCE(SUM(CASE WHEN transaction_type='issued' THEN amount ELSE -amount END),0) n FROM store_credit_transactions WHERE customer_id=?").get(customer.id).n);
   if(paid>available+0.00001)throw new Error(`Insufficient store credit. Available balance: ${available.toFixed(2)}.`);
  }
  const sale=db.prepare("INSERT INTO sales(receipt_no,subtotal,discount,tax,total,payment_method,amount_paid,change_due,cashier,shift_id,customer_id,amount_received,balance_due,tender_method,initial_paid) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(receipt,subtotal,d,t,total,payment_method,tendered,r2(Math.max(0,tendered-total)),req.user.name,activeShift?.id||null,customer?.id||null,paid,balance,tenderMethod,paid);
  const it=db.prepare("INSERT INTO sale_items(sale_id,product_id,product_name,quantity,unit_price,line_total,cost_price,discount_amount,tax_amount,cost_snapshot) VALUES(?,?,?,?,?,?,?,?,?,1)"),st=db.prepare("UPDATE products SET stock=stock-? WHERE id=?"),mv=db.prepare("INSERT INTO inventory_movements(product_id,product_name,movement_type,quantity_change,stock_after,reference,created_by) VALUES(?,?,?,?,?,?,?)");
  checked.forEach(x=>{it.run(sale.lastInsertRowid,x.p.id,x.p.name,x.q,x.p.price,x.line,x.p.cost,x.discountAmount,x.taxAmount);st.run(x.q,x.p.id);mv.run(x.p.id,x.p.name,'sale',-x.q,x.p.stock-x.q,receipt,req.user.name);});
  if(paid>0&&customer){db.prepare("INSERT INTO customer_payments(customer_id,sale_id,amount,method,note,received_by) VALUES(?,?,?,?,?,?)").run(customer.id,sale.lastInsertRowid,paid,tenderMethod,"Initial payment for "+receipt,req.user.name);if(tenderMethod==="Store Credit")db.prepare("INSERT INTO store_credit_transactions(customer_id,sale_id,transaction_type,amount,created_by) VALUES(?,?,?,?,?)").run(customer.id,sale.lastInsertRowid,"redeemed",paid,req.user.name);}
  const tenderCode=tenderAccountCode(tenderMethod);
  const cogs=checked.reduce((n,x)=>n+x.p.cost*x.q,0);
  const journal=[...(paid>0?[{code:tenderCode,debit:paid}]:[]),...(balance>0?[{code:'1100',debit:balance}]:[]),{code:'4000',credit:subtotal-d},{code:'2100',credit:t}];
  if(cogs>0)journal.push({code:'5000',debit:cogs},{code:'1200',credit:cogs});
  postJournal({description:'Sale '+receipt,sourceType:'sale',sourceId:sale.lastInsertRowid,lines:journal,userId:req.user.id});
  return db.prepare("SELECT * FROM sales WHERE id=?").get(sale.lastInsertRowid);
 });
 try{res.status(201).json(tx());}catch(e){res.status(400).json({error:e.message});}
});
app.get("/api/sales/:id/items",(req,res)=>res.json(db.prepare("SELECT * FROM sale_items WHERE sale_id=?").all(req.params.id)));
app.get("/api/expenses",(req,res)=>res.json(db.prepare("SELECT * FROM expenses ORDER BY id DESC LIMIT 300").all()));
app.post("/api/expenses",roles("admin","manager"),(req,res)=>{const p=req.body;if(!p.title||!(+p.amount>0)||!Number.isFinite(+p.amount))return res.status(400).json({error:"Enter description and valid amount."});try{const tx=db.transaction(()=>{const x=db.prepare("INSERT INTO expenses(title,category,amount,note) VALUES(?,?,?,?)").run(p.title,p.category||"General",+p.amount,p.note||"");const category=String(p.category||'').toLowerCase();const expenseCode=category==='rent'?'5100':'5100';postJournal({description:'Expense: '+p.title,sourceType:'expense',sourceId:x.lastInsertRowid,lines:[{code:expenseCode,debit:+p.amount},{code:'1000',credit:+p.amount}],userId:req.user.id});return x.lastInsertRowid;});res.status(201).json({id:tx()});}catch(e){res.status(400).json({error:e.message});}});
app.get("/api/customers",(req,res)=>res.json(db.prepare("SELECT c.*,COALESCE((SELECT SUM(CASE WHEN transaction_type='issued' THEN amount ELSE -amount END) FROM store_credit_transactions sc WHERE sc.customer_id=c.id),0) store_credit_balance FROM customers c ORDER BY c.name").all()));
app.post("/api/customers",(req,res)=>{const p=req.body;if(!p.name)return res.status(400).json({error:"Customer name required."});const x=db.prepare("INSERT INTO customers(name,phone,email) VALUES(?,?,?)").run(p.name,p.phone||"",p.email||"");res.status(201).json({id:x.lastInsertRowid});});
app.get("/api/suppliers",(req,res)=>res.json(db.prepare("SELECT * FROM suppliers ORDER BY name").all()));
app.post("/api/suppliers",roles("admin","manager"),(req,res)=>{const p=req.body;if(!p.name)return res.status(400).json({error:"Supplier name is required."});const x=db.prepare("INSERT INTO suppliers(name,phone,email,address) VALUES(?,?,?,?)").run(p.name,p.phone||"",p.email||"",p.address||"");res.status(201).json({id:x.lastInsertRowid});});
app.get("/api/purchases",(req,res)=>res.json(db.prepare("SELECT * FROM purchases ORDER BY id DESC").all()));
app.post("/api/purchases",roles("admin","manager"),(req,res)=>{
 const {supplier_id,items,notes="",amount_paid=0,payment_method="Cash"}=req.body;
 if(!Array.isArray(items)||!items.length)return res.status(400).json({error:"Add at least one purchase item."});
 const supplier=db.prepare("SELECT * FROM suppliers WHERE id=?").get(supplier_id);if(!supplier)return res.status(400).json({error:"Select a valid supplier."});
 let subtotal=0,lines=[];for(const i of items){const p=db.prepare("SELECT * FROM products WHERE id=?").get(i.product_id),q=validQty(i.quantity),cost=Number(i.unit_cost);if(!p||q<1||cost<0||!Number.isFinite(cost))return res.status(400).json({error:"Check purchase product, quantity and cost."});lines.push({p,q,cost,total:q*cost});subtotal+=q*cost;}
 subtotal=r2(subtotal);const paid=Number(amount_paid);if(!Number.isFinite(paid)||paid<0||paid>subtotal)return res.status(400).json({error:"Enter a valid supplier payment amount."});
 if(paid>0&&!PAYMENT_METHODS.includes(payment_method))return res.status(400).json({error:"Choose Cash, Mobile Money, Bank Transfer or Card for the supplier payment."});
 const no="PUR-"+Date.now().toString(36).toUpperCase()+"-"+crypto.randomBytes(2).toString("hex").toUpperCase();
 const tx=db.transaction(()=>{
  const x=db.prepare("INSERT INTO purchases(purchase_no,supplier_id,supplier_name,status,subtotal,total,notes,created_by,amount_paid,balance_due) VALUES(?,?,?,'received',?,?,?,?,?,?)").run(no,supplier.id,supplier.name,subtotal,subtotal,notes,req.user.name,paid,r2(subtotal-paid));
  const ins=db.prepare("INSERT INTO purchase_items(purchase_id,product_id,product_name,quantity,unit_cost,line_total) VALUES(?,?,?,?,?,?)"),upd=db.prepare("UPDATE products SET cost=CASE WHEN stock+?=0 THEN cost ELSE ((stock*cost)+(?*?))/(stock+?) END,stock=stock+? WHERE id=?"),mv=db.prepare("INSERT INTO inventory_movements(product_id,product_name,movement_type,quantity_change,stock_after,reference,created_by) VALUES(?,?,?,?,?,?,?)");
  lines.forEach(l=>{ins.run(x.lastInsertRowid,l.p.id,l.p.name,l.q,l.cost,l.total);upd.run(l.q,l.q,l.cost,l.q,l.q,l.p.id);const after=db.prepare('SELECT stock FROM products WHERE id=?').get(l.p.id).stock;mv.run(l.p.id,l.p.name,'purchase',l.q,after,no,req.user.name);});
  if(paid>0)db.prepare("INSERT INTO supplier_payments(supplier_id,purchase_id,amount,method,note,paid_by) VALUES(?,?,?,?,?,?)").run(supplier.id,x.lastInsertRowid,paid,payment_method,"Initial payment for "+no,req.user.name);
  const tenderCode=tenderAccountCode(payment_method);
  if(subtotal>0)postJournal({description:'Stock purchase '+no,sourceType:'purchase',sourceId:x.lastInsertRowid,lines:[{code:'1200',debit:subtotal},...(paid>0?[{code:tenderCode,credit:paid}]:[]),...(r2(subtotal-paid)>0?[{code:'2000',credit:r2(subtotal-paid)}]:[])],userId:req.user.id});
  return x.lastInsertRowid;
 });res.status(201).json({id:tx(),purchase_no:no});
});

// Purchase orders can be received in multiple deliveries. Stock changes only when quantities are received.
app.get("/api/purchase-orders",roles("admin","manager"),(req,res)=>res.json(db.prepare("SELECT po.*,COALESCE((SELECT SUM(ordered_qty) FROM purchase_order_items WHERE order_id=po.id),0) ordered_units,COALESCE((SELECT SUM(received_qty) FROM purchase_order_items WHERE order_id=po.id),0) received_units FROM purchase_orders po ORDER BY po.id DESC").all()));
app.get("/api/purchase-orders/:id",roles("admin","manager"),(req,res)=>{
 const order=db.prepare("SELECT * FROM purchase_orders WHERE id=?").get(req.params.id);if(!order)return res.status(404).json({error:"Purchase order not found."});
 res.json({...order,items:db.prepare("SELECT * FROM purchase_order_items WHERE order_id=?").all(order.id)});
});
app.post("/api/purchase-orders",roles("admin","manager"),(req,res)=>{
 const {supplier_id,items,notes=""}=req.body,supplier=db.prepare("SELECT * FROM suppliers WHERE id=?").get(supplier_id);
 if(!supplier||!Array.isArray(items)||!items.length)return res.status(400).json({error:"Choose a supplier and add at least one product."});
 const lines=[];for(const i of items){const p=db.prepare("SELECT * FROM products WHERE id=?").get(i.product_id),q=Number(i.quantity),cost=Number(i.unit_cost);if(!p||!Number.isInteger(q)||q<1||!Number.isFinite(cost)||cost<0)return res.status(400).json({error:"Check every product, ordered quantity and unit cost."});lines.push({p,q,cost});}
 const no="PO-"+Date.now().toString(36).toUpperCase()+"-"+crypto.randomBytes(2).toString("hex").toUpperCase();
 const tx=db.transaction(()=>{const x=db.prepare("INSERT INTO purchase_orders(order_no,supplier_id,supplier_name,notes,created_by) VALUES(?,?,?,?,?)").run(no,supplier.id,supplier.name,String(notes),req.user.name);const ins=db.prepare("INSERT INTO purchase_order_items(order_id,product_id,product_name,ordered_qty,unit_cost) VALUES(?,?,?,?,?)");lines.forEach(l=>ins.run(x.lastInsertRowid,l.p.id,l.p.name,l.q,l.cost));return x.lastInsertRowid;});
 res.status(201).json({id:tx(),order_no:no});
});
app.post("/api/purchase-orders/:id/receive",roles("admin","manager"),(req,res)=>{
 const id=Number(req.params.id),order=db.prepare("SELECT * FROM purchase_orders WHERE id=?").get(id);if(!order)return res.status(404).json({error:"Purchase order not found."});
 const items=req.body.items,paid=Number(req.body.amount_paid??0),payment_method=req.body.payment_method||"Cash";
 if(!Array.isArray(items)||!items.length)return res.status(400).json({error:"Enter received quantities."});
 const lines=[],seen=new Set();
 for(const i of items){const itemId=Number(i.item_id);if(seen.has(itemId))return res.status(400).json({error:"List each order line only once per delivery."});seen.add(itemId);const row=db.prepare("SELECT oi.* FROM purchase_order_items oi WHERE oi.id=? AND oi.order_id=?").get(itemId,id),q=Number(i.quantity);if(!row||!Number.isInteger(q)||q<0||q>(row.ordered_qty-row.received_qty))return res.status(400).json({error:"A received quantity is invalid or exceeds the outstanding quantity."});if(q)lines.push({...row,q});}
 if(!lines.length)return res.status(400).json({error:"Enter at least one quantity greater than zero."});
 const subtotal=r2(lines.reduce((n,l)=>n+l.q*l.unit_cost,0));
 if(!Number.isFinite(paid)||paid<0||paid>subtotal)return res.status(400).json({error:"Enter a valid supplier payment amount (zero up to the value received)."});
 if(paid>0&&!PAYMENT_METHODS.includes(payment_method))return res.status(400).json({error:"Choose Cash, Mobile Money, Bank Transfer or Card for the supplier payment."});
 const tx=db.transaction(()=>{
  const no="GRN-"+Date.now().toString(36).toUpperCase()+"-"+crypto.randomBytes(2).toString("hex").toUpperCase(),balance=r2(subtotal-paid);
  const bill=db.prepare("INSERT INTO purchases(purchase_no,supplier_id,supplier_name,status,subtotal,total,notes,created_by,amount_paid,balance_due) VALUES(?,?,?,'received',?,?,?,?,?,?)").run(no,order.supplier_id,order.supplier_name,subtotal,subtotal,"Delivery against "+order.order_no,req.user.name,paid,balance);
  const upItem=db.prepare("UPDATE purchase_order_items SET received_qty=received_qty+? WHERE id=?"),pit=db.prepare("INSERT INTO purchase_items(purchase_id,product_id,product_name,quantity,unit_cost,line_total) VALUES(?,?,?,?,?,?)"),upProd=db.prepare("UPDATE products SET cost=CASE WHEN stock+?=0 THEN cost ELSE ((stock*cost)+(?*?))/(stock+?) END,stock=stock+? WHERE id=?"),mv=db.prepare("INSERT INTO inventory_movements(product_id,product_name,movement_type,quantity_change,stock_after,reference,note,created_by) VALUES(?,?,?,?,?,?,?,?)");
  for(const l of lines){upItem.run(l.q,l.id);pit.run(bill.lastInsertRowid,l.product_id,l.product_name,l.q,l.unit_cost,r2(l.q*l.unit_cost));upProd.run(l.q,l.q,l.unit_cost,l.q,l.q,l.product_id);const after=db.prepare("SELECT stock FROM products WHERE id=?").get(l.product_id).stock;mv.run(l.product_id,l.product_name,"purchase_order_receipt",l.q,after,order.order_no,"Delivery "+no,req.user.name);}
  if(paid>0)db.prepare("INSERT INTO supplier_payments(supplier_id,purchase_id,amount,method,note,paid_by) VALUES(?,?,?,?,?,?)").run(order.supplier_id,bill.lastInsertRowid,paid,payment_method,"Initial payment for "+no,req.user.name);
  if(subtotal>0)postJournal({description:`Stock received ${no} (${order.order_no})`,sourceType:"purchase",sourceId:bill.lastInsertRowid,lines:[{code:"1200",debit:subtotal},...(paid>0?[{code:tenderAccountCode(payment_method),credit:paid}]:[]),...(balance>0?[{code:"2000",credit:balance}]:[])],userId:req.user.id});
  const pending=db.prepare("SELECT COUNT(*) n FROM purchase_order_items WHERE order_id=? AND received_qty<ordered_qty").get(id).n,status=pending?"part_received":"received";
  db.prepare("UPDATE purchase_orders SET status=? WHERE id=?").run(status,id);return {status,purchase_no:no,total:subtotal,balance_due:balance};
 });
 const out=tx();res.json({received:true,...out});
});
// Transfers are internal: quantity is moved between named locations; overall shop stock is unchanged.
app.post("/api/inventory/transfers",roles("admin","manager"),(req,res)=>{
 const {from_location,to_location,items,note=""}=req.body;if(!String(from_location||"").trim()||!String(to_location||"").trim()||from_location===to_location||!Array.isArray(items)||!items.length)return res.status(400).json({error:"Provide two different locations and at least one item."});
 const lines=[],seen=new Set();for(const i of items){if(seen.has(Number(i.product_id)))return res.status(400).json({error:"List each product only once per transfer."});seen.add(Number(i.product_id));const p=db.prepare("SELECT * FROM products WHERE id=?").get(i.product_id),q=Number(i.quantity);if(!p||!Number.isInteger(q)||q<1||q>p.stock)return res.status(400).json({error:"Transfer quantity is invalid or exceeds available shop stock."});lines.push({p,q});}
 const no="TR-"+Date.now().toString(36).toUpperCase();const tx=db.transaction(()=>{const x=db.prepare("INSERT INTO stock_transfers(transfer_no,from_location,to_location,note,created_by) VALUES(?,?,?,?,?)").run(no,from_location,to_location,String(note),req.user.name);const it=db.prepare("INSERT INTO stock_transfer_items(transfer_id,product_id,product_name,quantity) VALUES(?,?,?,?)"),mv=db.prepare("INSERT INTO inventory_movements(product_id,product_name,movement_type,quantity_change,stock_after,reference,note,created_by) VALUES(?,?,?,?,?,?,?,?)");lines.forEach(l=>{it.run(x.lastInsertRowid,l.p.id,l.p.name,l.q);mv.run(l.p.id,l.p.name,"transfer_out",0,l.p.stock,no,`${l.q} units moved from ${from_location} to ${to_location}`,req.user.name);});return x.lastInsertRowid;});res.status(201).json({id:tx(),transfer_no:no});
});
app.get("/api/inventory/transfers",roles("admin","manager"),(req,res)=>res.json(db.prepare("SELECT * FROM stock_transfers ORDER BY id DESC LIMIT 100").all()));
app.post("/api/inventory/stocktake",roles("admin","manager"),(req,res)=>{
 const {items,note=""}=req.body;if(!Array.isArray(items)||!items.length)return res.status(400).json({error:"Add counted quantities for at least one product."});
 const lines=[],seen=new Set();for(const i of items){if(seen.has(Number(i.product_id)))return res.status(400).json({error:"List each product only once per stocktake."});seen.add(Number(i.product_id));const p=db.prepare("SELECT * FROM products WHERE id=?").get(i.product_id),q=Number(i.counted_qty);if(!p||!Number.isInteger(q)||q<0)return res.status(400).json({error:"Choose valid products and whole-number counts."});lines.push({p,q,delta:q-p.stock});}
 const no="ST-"+Date.now().toString(36).toUpperCase();const tx=db.transaction(()=>{const x=db.prepare("INSERT INTO stocktakes(stocktake_no,note,created_by) VALUES(?,?,?)").run(no,String(note),req.user.name);const ins=db.prepare("INSERT INTO stocktake_items(stocktake_id,product_id,product_name,system_qty,counted_qty,variance) VALUES(?,?,?,?,?,?)"),up=db.prepare("UPDATE products SET stock=? WHERE id=?"),mv=db.prepare("INSERT INTO inventory_movements(product_id,product_name,movement_type,quantity_change,stock_after,reference,note,created_by) VALUES(?,?,?,?,?,?,?,?)");lines.forEach(l=>{ins.run(x.lastInsertRowid,l.p.id,l.p.name,l.p.stock,l.q,l.delta);if(l.delta){up.run(l.q,l.p.id);mv.run(l.p.id,l.p.name,"stocktake",l.delta,l.q,no,String(note),req.user.name);const value=Math.round(Math.abs(l.delta)*l.p.cost*100)/100;if(value>0)postJournal({description:`Stocktake ${no}: ${l.p.name}`,sourceType:'stocktake',sourceId:x.lastInsertRowid,lines:l.delta<0?[{code:'5200',debit:value},{code:'1200',credit:value}]:[{code:'1200',debit:value},{code:'5200',credit:value}],userId:req.user.id});}});return x.lastInsertRowid;});res.status(201).json({id:tx(),stocktake_no:no,adjusted:lines.filter(x=>x.delta).length});
});
app.get("/api/returns",roles("admin","manager"),(req,res)=>res.json(db.prepare("SELECT * FROM returns ORDER BY id DESC").all()));
app.post("/api/returns",roles("admin","manager"),(req,res)=>{
 const {sale_id,reason,refund_method="Cash",items}=req.body;
 if(!sale_id||!reason||!Array.isArray(items)||!items.length)return res.status(400).json({error:"Choose a sale, provide a reason and add return items."});
 if(!["Cash","Mobile Money","Bank Transfer","Card","Store Credit"].includes(refund_method))return res.status(400).json({error:"Select a valid refund method."});
 const sale=db.prepare("SELECT * FROM sales WHERE id=?").get(sale_id);if(!sale)return res.status(404).json({error:"Sale not found."});
 let total=0,netReturn=0,taxReturn=0,lines=[];const seen=new Set();
 for(const i of items){
  const productId=Number(i.product_id),q=Number(i.quantity);if(seen.has(productId))return res.status(400).json({error:"Add each product only once per return."});seen.add(productId);
  const original=db.prepare(`SELECT si.*,COALESCE((SELECT SUM(ri.quantity) FROM return_items ri JOIN returns r ON r.id=ri.return_id WHERE r.sale_id=si.sale_id AND ri.product_id=si.product_id),0) returned,COALESCE((SELECT SUM(ri.discount_amount) FROM return_items ri JOIN returns r ON r.id=ri.return_id WHERE r.sale_id=si.sale_id AND ri.product_id=si.product_id),0) discount_returned,COALESCE((SELECT SUM(ri.tax_amount) FROM return_items ri JOIN returns r ON r.id=ri.return_id WHERE r.sale_id=si.sale_id AND ri.product_id=si.product_id),0) tax_returned FROM sale_items si WHERE si.sale_id=? AND si.product_id=?`).get(sale_id,productId);
  if(!original||!Number.isInteger(q)||q<1||q>original.quantity-original.returned)return res.status(400).json({error:"Return quantity exceeds the remaining quantity sold."});
  const discountTarget=Math.round(Number(original.discount_amount||0)*100*(original.returned+q)/original.quantity)/100;
  const taxTarget=Math.round(Number(original.tax_amount||0)*100*(original.returned+q)/original.quantity)/100;
  const discountPart=Math.max(0,Math.round((discountTarget-Number(original.discount_returned||0))*100)/100);
  const taxPart=Math.max(0,Math.round((taxTarget-Number(original.tax_returned||0))*100)/100);
  const gross=Math.round(q*original.unit_price*100)/100,net=Math.max(0,Math.round((gross-discountPart)*100)/100),refund=Math.round((net+taxPart)*100)/100;
  lines.push({original,q,gross,discountPart,taxPart,net,refund});total+=refund;netReturn+=net;taxReturn+=taxPart;
 }
 total=Math.round(total*100)/100;netReturn=Math.round(netReturn*100)/100;taxReturn=Math.round(taxReturn*100)/100;
 const no="RET-"+Date.now().toString(36).toUpperCase()+"-"+crypto.randomBytes(2).toString("hex").toUpperCase();
 const tx=db.transaction(()=>{
  // Goods returned from a credit / part-paid sale first reduce what the customer still owes; only the remainder is refunded as tender.
  const fresh=db.prepare("SELECT balance_due FROM sales WHERE id=?").get(sale_id),offset=r2(Math.min(total,Number(fresh.balance_due)||0)),refundPaid=r2(total-offset);
  const retShift=db.prepare("SELECT id FROM shifts WHERE user_id=? AND status='open' ORDER BY id DESC LIMIT 1").get(req.user.id);
  const r=db.prepare("INSERT INTO returns(return_no,sale_id,reason,refund_method,total,processed_by,receivable_offset,shift_id) VALUES(?,?,?,?,?,?,?,?)").run(no,sale_id,reason,refund_method,total,req.user.name,offset,retShift?.id||null);
  if(offset>0)db.prepare("UPDATE sales SET balance_due=MAX(0,balance_due-?) WHERE id=?").run(offset,sale_id);
  if(refund_method==="Store Credit"&&refundPaid>0){if(!sale.customer_id)throw new Error("This sale has no linked customer. Store credit cannot be issued.");db.prepare("INSERT INTO store_credit_transactions(customer_id,return_id,transaction_type,amount,created_by) VALUES(?,?,?,?,?)").run(sale.customer_id,r.lastInsertRowid,"issued",refundPaid,req.user.name);}
  const ins=db.prepare("INSERT INTO return_items(return_id,product_id,product_name,quantity,unit_price,line_total,discount_amount,tax_amount) VALUES(?,?,?,?,?,?,?,?)"),up=db.prepare("UPDATE products SET stock=?,cost=? WHERE id=?"),mv=db.prepare("INSERT INTO inventory_movements(product_id,product_name,movement_type,quantity_change,stock_after,reference,created_by) VALUES(?,?,?,?,?,?,?)");
  lines.forEach(l=>{ins.run(r.lastInsertRowid,l.original.product_id,l.original.product_name,l.q,l.original.unit_price,l.refund,l.discountPart,l.taxPart);const current=db.prepare('SELECT stock,cost FROM products WHERE id=?').get(l.original.product_id);const returnCost=Number(l.original.cost_price)||0;const stock=current.stock+l.q;const averageCost=stock>0?Math.round(((current.stock*current.cost)+(l.q*returnCost))/stock*10000)/10000:0;up.run(stock,averageCost,l.original.product_id);mv.run(l.original.product_id,l.original.product_name,'return',l.q,stock,no,req.user.name);});
  const refundCode=refund_method==='Store Credit'?'2200':tenderAccountCode(refund_method),returnLines=[];
  if(netReturn>0)returnLines.push({code:'4100',debit:netReturn});if(taxReturn>0)returnLines.push({code:'2100',debit:taxReturn});if(offset>0)returnLines.push({code:'1100',credit:offset});if(refundPaid>0)returnLines.push({code:refundCode,credit:refundPaid});
  const restoredCost=lines.reduce((n,l)=>n+(Number(l.original.cost_price)||0)*l.q,0);if(restoredCost>0)returnLines.push({code:'1200',debit:restoredCost},{code:'5000',credit:restoredCost});
  if(returnLines.length)postJournal({description:'Sales return '+no,sourceType:'return',sourceId:r.lastInsertRowid,lines:returnLines,userId:req.user.id});return {id:r.lastInsertRowid,offset,refundPaid};
 });
 try{const out=tx();res.status(201).json({id:out.id,return_no:no,total,net_return:netReturn,tax_return:taxReturn,receivable_offset:out.offset,refund_paid:out.refundPaid});}catch(e){res.status(400).json({error:e.message});}
});
app.get("/api/reports/overview",roles("admin","manager"),(req,res)=>{const daily=db.prepare("SELECT date(created_at) date,COUNT(*) orders,SUM(total) sales FROM sales GROUP BY date(created_at) ORDER BY date DESC LIMIT 30").all(),top=db.prepare("SELECT product_name name,SUM(quantity) quantity,SUM(line_total) revenue FROM sale_items GROUP BY product_id,product_name ORDER BY quantity DESC LIMIT 8").all();const bal=ledgerBalances(),gross=r2(-bal("4000")-bal("4100")-bal("5000"));res.json({daily,top,gross});});
// Inventory controls and auditable stock adjustments.
app.get("/api/inventory/movements",roles("admin","manager"),(req,res)=>res.json(db.prepare("SELECT * FROM inventory_movements ORDER BY id DESC LIMIT 500").all()));
app.post("/api/inventory/adjust",roles("admin","manager"),(req,res)=>{const {product_id,new_stock,note=""}=req.body;const p=db.prepare("SELECT * FROM products WHERE id=?").get(product_id);const target=Number(new_stock);if(!p||!Number.isInteger(target)||target<0||!String(note).trim())return res.status(400).json({error:"Select a product, enter a non-negative whole-number stock count and provide a reason."});const delta=target-p.stock;if(!delta)return res.status(400).json({error:"The counted stock is already the recorded stock."});const tx=db.transaction(()=>{db.prepare("UPDATE products SET stock=? WHERE id=?").run(target,p.id);const movement=db.prepare("INSERT INTO inventory_movements(product_id,product_name,movement_type,quantity_change,stock_after,reference,note,created_by) VALUES(?,?,?,?,?,?,?,?)").run(p.id,p.name,"adjustment",delta,target,"MANUAL",note,req.user.name);const value=Math.round(Math.abs(delta)*p.cost*100)/100;if(value>0)postJournal({description:`Inventory adjustment: ${p.name} (${note})`,sourceType:'inventory_adjustment',sourceId:movement.lastInsertRowid,lines:delta<0?[{code:'5200',debit:value},{code:'1200',credit:value}]:[{code:'1200',debit:value},{code:'5200',credit:value}],userId:req.user.id});});tx();res.json({updated:true,previous_stock:p.stock,new_stock:target,quantity_change:delta,accounting_value:Math.round(Math.abs(delta)*p.cost*100)/100});});
// Register shifts and cash reconciliation. Sales are associated with the cashier's open shift.
app.get("/api/shifts/current",(req,res)=>{const shift=db.prepare("SELECT * FROM shifts WHERE user_id=? AND status='open' ORDER BY id DESC LIMIT 1").get(req.user.id);if(!shift)return res.json(null);const c=shiftCash(shift.id);res.json({...shift,...c,expected_cash:r2(shift.opening_cash+c.cash_sales+c.cash_receipts-c.cash_refunds)});});
app.get("/api/shifts",roles("admin","manager"),(req,res)=>res.json(db.prepare("SELECT * FROM shifts ORDER BY id DESC LIMIT 100").all().map(s=>({...s,...shiftCash(s.id)}))));
app.post("/api/shifts/open",(req,res)=>{const existing=db.prepare("SELECT id FROM shifts WHERE user_id=? AND status='open'").get(req.user.id);if(existing)return res.status(400).json({error:"You already have an open shift."});const cash=Number(req.body.opening_cash);if(!Number.isFinite(cash)||cash<0)return res.status(400).json({error:"Enter a valid opening cash amount."});const x=db.prepare("INSERT INTO shifts(user_id,cashier_name,opening_cash) VALUES(?,?,?)").run(req.user.id,req.user.name,cash);res.status(201).json({id:x.lastInsertRowid});});
app.post("/api/shifts/:id/close",(req,res)=>{const shift=db.prepare("SELECT * FROM shifts WHERE id=? AND user_id=? AND status='open'").get(req.params.id,req.user.id);if(!shift)return res.status(404).json({error:"Open shift not found for this account."});const cash=Number(req.body.closing_cash);if(!Number.isFinite(cash)||cash<0)return res.status(400).json({error:"Enter a valid counted cash amount."});const c=shiftCash(shift.id),expected=r2(shift.opening_cash+c.cash_sales+c.cash_receipts-c.cash_refunds),difference=r2(cash-expected);db.prepare("UPDATE shifts SET closing_cash=?,expected_cash=?,cash_difference=?,status='closed',closed_at=CURRENT_TIMESTAMP WHERE id=?").run(cash,expected,difference,shift.id);res.json({closed:true,opening_cash:shift.opening_cash,cash_sales:c.cash_sales,cash_receipts:c.cash_receipts,cash_refunds:c.cash_refunds,expected_cash:expected,closing_cash:cash,cash_difference:difference});});

// Customer credit ledger and receipts.
app.get("/api/credit/customers",roles("admin","manager","cashier"),(req,res)=>{
 const rows=db.prepare(`SELECT c.id,c.name,c.phone,COALESCE((SELECT SUM(balance_due) FROM sales WHERE customer_id=c.id),0) balance_due,
 COALESCE((SELECT SUM(amount) FROM customer_payments WHERE customer_id=c.id),0) total_paid,
 COALESCE((SELECT SUM(CASE WHEN transaction_type='issued' THEN amount ELSE -amount END) FROM store_credit_transactions sc WHERE sc.customer_id=c.id),0) store_credit_balance
 FROM customers c ORDER BY balance_due DESC,c.name`).all();
 res.json(rows);
});
app.get("/api/credit/customers/:id/ledger",roles("admin","manager","cashier"),(req,res)=>{
 const id=Number(req.params.id),customer=db.prepare("SELECT id,name,phone FROM customers WHERE id=?").get(id);if(!customer)return res.status(404).json({error:"Customer not found."});
 const sales=db.prepare("SELECT id,receipt_no,total,amount_received,balance_due,created_at FROM sales WHERE customer_id=? ORDER BY id DESC").all(id);
 const payments=db.prepare("SELECT id,sale_id,amount,method,note,received_by,created_at FROM customer_payments WHERE customer_id=? ORDER BY id DESC").all(id);
 const store_credit_transactions=db.prepare("SELECT * FROM store_credit_transactions WHERE customer_id=? ORDER BY id DESC").all(id);const store_credit_balance=store_credit_transactions.reduce((n,x)=>n+(x.transaction_type==="issued"?x.amount:-x.amount),0);res.json({customer,sales,payments,balance_due:sales.reduce((a,x)=>a+x.balance_due,0),store_credit_balance,store_credit_transactions});
});
app.post("/api/credit/customers/:id/payments",roles("admin","manager","cashier"),(req,res)=>{
 const id=Number(req.params.id),amount=r2(Number(req.body.amount)),method=String(req.body.method||"Cash"),saleId=req.body.sale_id?Number(req.body.sale_id):null,note=String(req.body.note||"");
 const customer=db.prepare("SELECT * FROM customers WHERE id=?").get(id);if(!customer)return res.status(404).json({error:"Customer not found."});
 if(!Number.isFinite(amount)||amount<=0)return res.status(400).json({error:"Enter a payment amount greater than zero."});
 if(!["Cash","Mobile Money","Bank Transfer","Card"].includes(method))return res.status(400).json({error:"Choose a valid cash, bank, card or Mobile Money receipt method."});
 const due=saleId?db.prepare("SELECT * FROM sales WHERE id=? AND customer_id=?").get(saleId,id):null;
 if(saleId&&!due)return res.status(404).json({error:"Customer sale not found."});
 const totalDue=saleId?due.balance_due:db.prepare("SELECT COALESCE(SUM(balance_due),0) n FROM sales WHERE customer_id=?").get(id).n;
 if(amount>totalDue+0.00001)return res.status(400).json({error:"Payment exceeds the outstanding balance."});
 const tx=db.transaction(()=>{
  const p=db.prepare("INSERT INTO customer_payments(customer_id,sale_id,amount,method,note,received_by,shift_id) VALUES(?,?,?,?,?,?,(SELECT id FROM shifts WHERE user_id=? AND status='open' ORDER BY id DESC LIMIT 1))").run(id,saleId,amount,method,note,req.user.name,req.user.id);
  let remaining=amount;
  const open=saleId?[due]:db.prepare("SELECT * FROM sales WHERE customer_id=? AND balance_due>0 ORDER BY id").all(id);
  for(const sale of open){if(remaining<=0)break;const applied=Math.min(remaining,sale.balance_due);db.prepare("UPDATE sales SET amount_received=amount_received+?,balance_due=MAX(0,balance_due-?) WHERE id=?").run(applied,applied,sale.id);remaining-=applied;}
  const tenderCode=tenderAccountCode(method);postJournal({description:'Customer receipt '+p.lastInsertRowid,sourceType:'customer_payment',sourceId:p.lastInsertRowid,lines:[{code:tenderCode,debit:amount},{code:'1100',credit:amount}],userId:req.user.id});
  return p.lastInsertRowid;
 });
 res.status(201).json({id:tx(),customer_id:id,amount,balance_due:db.prepare("SELECT COALESCE(SUM(balance_due),0) n FROM sales WHERE customer_id=?").get(id).n});
});
app.get("/api/credit/suppliers",roles("admin","manager","cashier"),(req,res)=>res.json(db.prepare(`SELECT s.id,s.name,s.phone,COALESCE((SELECT SUM(balance_due) FROM purchases WHERE supplier_id=s.id),0) balance_due,COALESCE((SELECT SUM(amount) FROM supplier_payments WHERE supplier_id=s.id),0) total_paid FROM suppliers s ORDER BY balance_due DESC,s.name`).all()));
app.post("/api/credit/suppliers/:id/payments",roles("admin","manager"),(req,res)=>{
 const id=Number(req.params.id),amount=r2(Number(req.body.amount)),method=String(req.body.method||"Cash"),purchaseId=req.body.purchase_id?Number(req.body.purchase_id):null,note=String(req.body.note||"");
 const supplier=db.prepare("SELECT * FROM suppliers WHERE id=?").get(id);if(!supplier)return res.status(404).json({error:"Supplier not found."});
 if(!Number.isFinite(amount)||amount<=0)return res.status(400).json({error:"Enter a payment amount greater than zero."});
 if(!PAYMENT_METHODS.includes(method))return res.status(400).json({error:"Choose Cash, Mobile Money, Bank Transfer or Card for the supplier payment."});
 const purchase=purchaseId?db.prepare("SELECT * FROM purchases WHERE id=? AND supplier_id=?").get(purchaseId,id):null;if(purchaseId&&!purchase)return res.status(404).json({error:"Supplier purchase not found."});
 const totalDue=purchaseId?purchase.balance_due:db.prepare("SELECT COALESCE(SUM(balance_due),0) n FROM purchases WHERE supplier_id=?").get(id).n;
 if(amount>totalDue+0.00001)return res.status(400).json({error:"Payment exceeds the outstanding supplier balance."});
 const tx=db.transaction(()=>{
  const p=db.prepare("INSERT INTO supplier_payments(supplier_id,purchase_id,amount,method,note,paid_by) VALUES(?,?,?,?,?,?)").run(id,purchaseId,amount,method,note,req.user.name);
  let remaining=amount;const open=purchaseId?[purchase]:db.prepare("SELECT * FROM purchases WHERE supplier_id=? AND balance_due>0 ORDER BY id").all(id);
  for(const bill of open){if(remaining<=0)break;const applied=Math.min(remaining,bill.balance_due);db.prepare("UPDATE purchases SET amount_paid=amount_paid+?,balance_due=MAX(0,balance_due-?) WHERE id=?").run(applied,applied,bill.id);remaining-=applied;}
  const tenderCode=tenderAccountCode(method);postJournal({description:'Supplier payment '+p.lastInsertRowid,sourceType:'supplier_payment',sourceId:p.lastInsertRowid,lines:[{code:'2000',debit:amount},{code:tenderCode,credit:amount}],userId:req.user.id});
  return p.lastInsertRowid;
 });
 res.status(201).json({id:tx(),supplier_id:id,amount,balance_due:db.prepare("SELECT COALESCE(SUM(balance_due),0) n FROM purchases WHERE supplier_id=?").get(id).n});
});
// Accounting API: posted entries and their posted reversals remain in the ledger for a complete audit trail.
app.get('/api/accounting/accounts',roles('admin','manager'),(req,res)=>res.json(db.prepare("SELECT a.*,COALESCE(SUM(CASE WHEN e.status IN ('posted','reversed') THEN l.debit-l.credit ELSE 0 END),0) balance_signed FROM accounts a LEFT JOIN journal_lines l ON l.account_id=a.id LEFT JOIN journal_entries e ON e.id=l.entry_id GROUP BY a.id ORDER BY a.code").all()));
app.post('/api/accounting/accounts',roles('admin'),(req,res)=>{const {code,name,type,normal_balance}=req.body;if(!/^\d{3,8}$/.test(String(code||''))||!String(name||'').trim()||!['asset','liability','equity','income','expense'].includes(type)||!['debit','credit'].includes(normal_balance))return res.status(400).json({error:'Enter a valid account code, name, type and normal balance.'});try{const x=db.prepare('INSERT INTO accounts(code,name,type,normal_balance) VALUES(?,?,?,?)').run(code,name.trim(),type,normal_balance);res.status(201).json({id:x.lastInsertRowid});}catch(e){res.status(400).json({error:'Account code already exists.'});}});
app.get('/api/accounting/journals',roles('admin','manager'),(req,res)=>res.json(db.prepare("SELECT e.*,u.name created_by_name,ROUND(SUM(l.debit),2) total_debit,ROUND(SUM(l.credit),2) total_credit FROM journal_entries e JOIN journal_lines l ON l.entry_id=e.id LEFT JOIN users u ON u.id=e.created_by GROUP BY e.id ORDER BY e.id DESC LIMIT 300").all()));
app.get('/api/accounting/journals/:id',roles('admin','manager'),(req,res)=>{const e=db.prepare('SELECT * FROM journal_entries WHERE id=?').get(req.params.id);if(!e)return res.status(404).json({error:'Journal entry not found.'});res.json({...e,lines:db.prepare('SELECT l.*,a.code,a.name account_name FROM journal_lines l JOIN accounts a ON a.id=l.account_id WHERE l.entry_id=? ORDER BY l.id').all(e.id)});});
app.post('/api/accounting/journals',roles('admin','manager'),(req,res)=>{const {description,entry_date,lines}=req.body;if(!String(description||'').trim()||!Array.isArray(lines))return res.status(400).json({error:'Description and journal lines are required.'});try{const tx=db.transaction(()=>postJournal({description:String(description).trim(),entryDate:entry_date||new Date().toISOString().slice(0,10),lines,sourceType:'manual',userId:req.user.id}));res.status(201).json(tx());}catch(e){res.status(400).json({error:e.message});}});
app.get('/api/accounting/opening-balances/status',roles('admin','manager'),(req,res)=>{const row=db.prepare("SELECT value FROM accounting_controls WHERE key='opening_balances_posted'").get();res.json({posted:!!row,posted_at:row?.value||null});});
app.post('/api/accounting/opening-balances',roles('admin'),(req,res)=>{const {entry_date,lines}=req.body;if(!Array.isArray(lines)||!lines.length)return res.status(400).json({error:'Add opening balances for at least two accounts.'});try{const tx=db.transaction(()=>{if(db.prepare("SELECT 1 FROM accounting_controls WHERE key='opening_balances_posted'").get())throw new Error('Opening balances have already been posted. Correct them using an approved adjusting journal.');if(lines.some(l=>{const account=l.account_id?db.prepare('SELECT type FROM accounts WHERE id=? AND active=1').get(Number(l.account_id)):db.prepare('SELECT type FROM accounts WHERE code=? AND active=1').get(l.code);return !account||!['asset','liability','equity'].includes(account.type);}))throw new Error('Opening balances may only use active asset, liability or equity accounts.');const result=postJournal({description:'Opening balances',entryDate:entry_date||new Date().toISOString().slice(0,10),lines,sourceType:'opening_balance',userId:req.user.id});db.prepare("INSERT INTO accounting_controls(key,value) VALUES('opening_balances_posted',?)").run(now());return result;});res.status(201).json(tx());}catch(e){res.status(400).json({error:e.message});}});
app.get('/api/accounting/ledger/:accountId',roles('admin','manager'),(req,res)=>{const account=db.prepare('SELECT * FROM accounts WHERE id=?').get(req.params.accountId);if(!account)return res.status(404).json({error:'Account not found.'});const rows=db.prepare("SELECT e.id entry_id,e.entry_no,e.entry_date,e.description entry_description,e.status,l.description,l.debit,l.credit FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id WHERE l.account_id=? AND e.status IN ('posted','reversed') ORDER BY e.entry_date,e.id,l.id").all(account.id);let running=0;const ledger=rows.map(r=>{running+=account.normal_balance==='debit'?r.debit-r.credit:r.credit-r.debit;return {...r,running_balance:Math.round(running*100)/100};});res.json({account,ledger,closing_balance:running});});
app.get('/api/accounting/trial-balance',roles('admin','manager'),(req,res)=>{const rows=db.prepare("SELECT a.id,a.code,a.name,a.type,a.normal_balance,ROUND(COALESCE(SUM(CASE WHEN e.status IN ('posted','reversed') THEN l.debit ELSE 0 END),0),2) debits,ROUND(COALESCE(SUM(CASE WHEN e.status IN ('posted','reversed') THEN l.credit ELSE 0 END),0),2) credits FROM accounts a LEFT JOIN journal_lines l ON l.account_id=a.id LEFT JOIN journal_entries e ON e.id=l.entry_id GROUP BY a.id ORDER BY a.code").all();const data=rows.map(a=>{const signed=a.debits-a.credits;return {...a,debit_balance:Math.max(0,signed),credit_balance:Math.max(0,-signed)}});res.json({accounts:data,total_debits:data.reduce((n,a)=>n+a.debit_balance,0),total_credits:data.reduce((n,a)=>n+a.credit_balance,0)});});
app.get('/api/accounting/statements',roles('admin','manager'),(req,res)=>{const rows=db.prepare("SELECT a.code,a.name,a.type,a.normal_balance,COALESCE(SUM(CASE WHEN e.status IN ('posted','reversed') THEN l.debit-l.credit ELSE 0 END),0) signed FROM accounts a LEFT JOIN journal_lines l ON l.account_id=a.id LEFT JOIN journal_entries e ON e.id=l.entry_id GROUP BY a.id ORDER BY a.code").all();const amount=a=>a.type==='asset'?a.signed:a.type==='expense'?a.signed:a.type==='income'?-a.signed:a.type==='liability'||a.type==='equity'?-a.signed:a.signed;const income=rows.filter(a=>a.type==='income').reduce((n,a)=>n+amount(a),0),expenses=rows.filter(a=>a.type==='expense').reduce((n,a)=>n+amount(a),0),assets=rows.filter(a=>a.type==='asset').reduce((n,a)=>n+amount(a),0),liabilities=rows.filter(a=>a.type==='liability').reduce((n,a)=>n+amount(a),0),equity=rows.filter(a=>a.type==='equity').reduce((n,a)=>n+amount(a),0);res.json({income,expenses,net_profit:income-expenses,assets,liabilities,equity:equity+(income-expenses),balance_check:assets-liabilities-equity-(income-expenses),accounts:rows});});
app.get('/api/accounting/reconciliation',roles('admin','manager'),(req,res)=>{
 const activeStatuses="('posted','reversed')";
 const tb=db.prepare(`SELECT ROUND(COALESCE(SUM(l.debit),0),2) debits,ROUND(COALESCE(SUM(l.credit),0),2) credits FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id WHERE e.status IN ${activeStatuses}`).get();
 const invalid=db.prepare(`SELECT e.id,e.entry_no,e.status,ROUND(SUM(l.debit),2) debits,ROUND(SUM(l.credit),2) credits,COUNT(l.id) line_count FROM journal_entries e LEFT JOIN journal_lines l ON l.entry_id=e.id WHERE e.status IN ${activeStatuses} GROUP BY e.id HAVING ABS(COALESCE(SUM(l.debit),0)-COALESCE(SUM(l.credit),0))>0.005 OR COUNT(l.id)<2`).all();
 const unjournaled={
  sales:db.prepare("SELECT COUNT(*) n FROM sales s WHERE NOT EXISTS(SELECT 1 FROM journal_entries e WHERE e.source_type='sale' AND e.source_id=s.id AND e.status IN ('posted','reversed'))").get().n,
  purchases:db.prepare("SELECT COUNT(*) n FROM purchases p WHERE NOT EXISTS(SELECT 1 FROM journal_entries e WHERE e.source_type='purchase' AND e.source_id=p.id AND e.status IN ('posted','reversed'))").get().n,
  expenses:db.prepare("SELECT COUNT(*) n FROM expenses x WHERE NOT EXISTS(SELECT 1 FROM journal_entries e WHERE e.source_type='expense' AND e.source_id=x.id AND e.status IN ('posted','reversed'))").get().n,
  returns:db.prepare("SELECT COUNT(*) n FROM returns r WHERE NOT EXISTS(SELECT 1 FROM journal_entries e WHERE e.source_type='return' AND e.source_id=r.id AND e.status IN ('posted','reversed'))").get().n,
  customer_payments:db.prepare("SELECT COUNT(*) n FROM customer_payments p WHERE NOT (p.note LIKE 'Initial payment for %' AND p.sale_id IS NOT NULL AND EXISTS(SELECT 1 FROM journal_entries se WHERE se.source_type='sale' AND se.source_id=p.sale_id AND se.status IN ('posted','reversed'))) AND NOT EXISTS(SELECT 1 FROM journal_entries e WHERE e.source_type='customer_payment' AND e.source_id=p.id)").get().n,
  supplier_payments:db.prepare("SELECT COUNT(*) n FROM supplier_payments p WHERE NOT (p.note LIKE 'Initial payment for %' AND p.purchase_id IS NOT NULL AND EXISTS(SELECT 1 FROM journal_entries pe WHERE pe.source_type='purchase' AND pe.source_id=p.purchase_id AND pe.status IN ('posted','reversed'))) AND NOT EXISTS(SELECT 1 FROM journal_entries e WHERE e.source_type='supplier_payment' AND e.source_id=p.id)").get().n
 };
 const reversedSourceJournals=db.prepare("SELECT source_type,COUNT(*) count FROM journal_entries WHERE status='reversed' AND source_type IS NOT NULL AND source_type<>'reversal' GROUP BY source_type ORDER BY source_type").all();
 const duplicateSources=db.prepare(`SELECT source_type,source_id,COUNT(*) count,GROUP_CONCAT(id) journal_ids FROM journal_entries WHERE source_type IN ('sale','purchase','expense','return','customer_payment','supplier_payment','opening_balance') AND source_id IS NOT NULL GROUP BY source_type,source_id HAVING COUNT(*)>1`).all();
 const reversalIntegrity=db.prepare(`SELECT r.id,r.entry_no,r.source_id,r.reversal_of,o.status original_status,COUNT(rl.id) reversal_lines FROM journal_entries r LEFT JOIN journal_entries o ON o.id=r.reversal_of LEFT JOIN journal_lines rl ON rl.entry_id=r.id WHERE r.source_type='reversal' GROUP BY r.id HAVING r.reversal_of IS NULL OR o.id IS NULL OR o.status<>'reversed' OR COALESCE(r.source_id,-1)<>o.id OR COUNT(rl.id)<2`).all();
 const originalsWithoutReversal=db.prepare(`SELECT o.id,o.entry_no,o.status FROM journal_entries o WHERE o.status='reversed' AND NOT EXISTS(SELECT 1 FROM journal_entries r WHERE r.reversal_of=o.id AND r.source_type='reversal')`).all();
 const reversalTargetsNotReversed=db.prepare(`SELECT r.id,r.entry_no,o.id original_id,o.status original_status FROM journal_entries r JOIN journal_entries o ON o.id=r.reversal_of WHERE r.reversal_of IS NOT NULL AND o.status<>'reversed'`).all();
 const legacyCost=db.prepare('SELECT COUNT(*) n FROM sale_items WHERE cost_snapshot=0').get().n;
 const bal=ledgerBalances(),invLines=db.prepare("SELECT COUNT(*) n FROM journal_lines l JOIN accounts a ON a.id=l.account_id WHERE a.code='1200'").get().n;
 const sum=sql=>r2(Number(db.prepare(sql).get().n)||0);
 const mk=(name,sub,led,tol)=>({name,subledger:sub,ledger:led,difference:r2(sub-led),tolerance:tol,ok:Math.abs(sub-led)<=tol+1e-9});
 const subledger_checks=[
  mk('Inventory: stock on hand x cost vs account 1200',sum('SELECT COALESCE(SUM(stock*cost),0) n FROM products'),bal('1200'),r2(0.01+0.005*invLines)),
  mk('Customer balances vs Accounts Receivable (1100)',sum('SELECT COALESCE(SUM(balance_due),0) n FROM sales'),bal('1100'),0.01),
  mk('Supplier balances vs Accounts Payable (2000)',sum('SELECT COALESCE(SUM(balance_due),0) n FROM purchases'),-bal('2000'),0.01),
  mk('Store-credit balances vs Store Credit Liability (2200)',sum("SELECT COALESCE(SUM(CASE WHEN transaction_type='issued' THEN amount ELSE -amount END),0) n FROM store_credit_transactions"),-bal('2200'),0.01)
 ];
 const debitCreditDifference=Math.round((tb.debits-tb.credits)*100)/100;
 res.json({total_debits:tb.debits,total_credits:tb.credits,difference:debitCreditDifference,balanced:Math.abs(debitCreditDifference)<0.005,invalid_entries:invalid,unjournaled,reversed_source_journals:reversedSourceJournals,duplicate_sources:duplicateSources,reversal_integrity_issues:reversalIntegrity,reversed_entries_without_reversal:originalsWithoutReversal,reversal_targets_not_reversed:reversalTargetsNotReversed,legacy_sales_without_cost_snapshot:legacyCost,subledger_checks});
});
app.post('/api/accounting/journals/:id/reverse',roles('admin'),(req,res)=>{const original=db.prepare("SELECT * FROM journal_entries WHERE id=? AND status='posted'").get(req.params.id);if(!original)return res.status(404).json({error:'Posted journal entry not found.'});if(original.source_type!=='manual')return res.status(400).json({error:'Only manual journals can be reversed directly. Correct system-generated entries through the business workflow (return, stock adjustment or payment correction) so stock and customer/supplier balances stay in agreement with the ledger.'});try{const tx=db.transaction(()=>{const prior=db.prepare('SELECT id FROM journal_entries WHERE reversal_of=?').get(original.id);if(prior)throw new Error('This journal entry has already been reversed.');const lines=db.prepare('SELECT account_id,description,debit,credit FROM journal_lines WHERE entry_id=?').all(original.id).map(l=>({...l,debit:l.credit,credit:l.debit}));const rev=postJournal({description:'Reversal: '+original.description,sourceType:'reversal',sourceId:original.id,lines,userId:req.user.id});db.prepare("UPDATE journal_entries SET status='reversed',reversed_by=?,reversed_at=CURRENT_TIMESTAMP WHERE id=?").run(req.user.id,original.id);db.prepare('UPDATE journal_entries SET reversal_of=? WHERE id=?').run(original.id,rev.id);return rev;});res.json(tx());}catch(e){res.status(400).json({error:e.message});}});

app.get("/api/reports/financial",roles("admin","manager"),(req,res)=>{
 const balances=db.prepare(`SELECT a.code,a.name,a.type,ROUND(COALESCE(SUM(CASE WHEN e.status IN ('posted','reversed') THEN l.debit-l.credit ELSE 0 END),0),2) signed FROM accounts a LEFT JOIN journal_lines l ON l.account_id=a.id LEFT JOIN journal_entries e ON e.id=l.entry_id GROUP BY a.id`).all();
 const bal=code=>Number(balances.find(a=>a.code===code)?.signed||0);
 const salesRevenue=Math.round(-bal('4000')*100)/100;
 const refunds=Math.round(bal('4100')*100)/100;
 const cogs=Math.round(bal('5000')*100)/100;
 const operatingExpenses=Math.round(bal('5100')*100)/100;
 const inventoryAdjustments=Math.round(bal('5200')*100)/100;
 const netRevenue=Math.round((salesRevenue-refunds)*100)/100;
 const gross=Math.round((netRevenue-cogs)*100)/100;
 const expenses=Math.round((operatingExpenses+inventoryAdjustments)*100)/100;
 const net=Math.round((gross-expenses)*100)/100;
 const purchases=db.prepare("SELECT COALESCE(SUM(CASE WHEN e.source_type='purchase' THEN l.debit-l.credit WHEN e.source_type='reversal' AND o.source_type='purchase' THEN l.debit-l.credit ELSE 0 END),0) total FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id LEFT JOIN journal_entries o ON o.id=e.reversal_of JOIN accounts a ON a.id=l.account_id WHERE a.code='1200'").get().total;
 const monthly=db.prepare(`SELECT strftime('%Y-%m',e.entry_date) month,ROUND(SUM(CASE WHEN a.code='4000' THEN l.credit-l.debit WHEN a.code='4100' THEN l.credit-l.debit ELSE 0 END),2) revenue FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id JOIN accounts a ON a.id=l.account_id WHERE a.code IN ('4000','4100') AND e.status IN ('posted','reversed') GROUP BY strftime('%Y-%m',e.entry_date) ORDER BY month DESC LIMIT 12`).all();
 res.json({sales:{total:salesRevenue,net_revenue:netRevenue},purchases:{total:Math.round(Number(purchases)*100)/100},expenses,operating_expenses:operatingExpenses,inventory_adjustments:inventoryAdjustments,cogs,refunds,gross_profit:gross,net_profit:net,monthly});
});
app.get("/api/export",roles("admin"),(req,res)=>{const data={exported_at:now(),products:db.prepare("SELECT * FROM products").all(),sales:db.prepare("SELECT * FROM sales").all(),sale_items:db.prepare("SELECT * FROM sale_items").all(),expenses:db.prepare("SELECT * FROM expenses").all(),customers:db.prepare("SELECT * FROM customers").all(),suppliers:db.prepare("SELECT * FROM suppliers").all(),purchases:db.prepare("SELECT * FROM purchases").all(),purchase_items:db.prepare("SELECT * FROM purchase_items").all(),returns:db.prepare("SELECT * FROM returns").all(),return_items:db.prepare("SELECT * FROM return_items").all(),inventory_movements:db.prepare("SELECT * FROM inventory_movements").all(),shifts:db.prepare("SELECT * FROM shifts").all(),customer_payments:db.prepare("SELECT * FROM customer_payments").all(),supplier_payments:db.prepare("SELECT * FROM supplier_payments").all(),purchase_orders:db.prepare("SELECT * FROM purchase_orders").all(),purchase_order_items:db.prepare("SELECT * FROM purchase_order_items").all(),stock_transfers:db.prepare("SELECT * FROM stock_transfers").all(),stock_transfer_items:db.prepare("SELECT * FROM stock_transfer_items").all(),stocktakes:db.prepare("SELECT * FROM stocktakes").all(),stocktake_items:db.prepare("SELECT * FROM stocktake_items").all(),store_credit_transactions:db.prepare("SELECT * FROM store_credit_transactions").all(),accounting_controls:db.prepare("SELECT * FROM accounting_controls").all(),accounts:db.prepare("SELECT * FROM accounts").all(),journal_entries:db.prepare("SELECT * FROM journal_entries").all(),journal_lines:db.prepare("SELECT * FROM journal_lines").all()};res.setHeader("Content-Disposition",'attachment; filename="shopflow-backup.json"');res.json(data);});
app.get("*",(req,res)=>{if(req.path.startsWith("/api/"))return res.status(404).json({error:"Not found."});res.sendFile(path.join(__dirname,"public","index.html"));});
app.use((err,req,res,next)=>{
 if(res.headersSent)return next(err);
 const status=err.status||err.statusCode||500;if(status>=500)console.error(err);
 const msg=err.type==="entity.parse.failed"?"Malformed JSON request.":status<500?err.message:/FOREIGN KEY/.test(err.message)?"This record is referenced by other records and cannot be changed this way.":/UNIQUE/.test(err.message)?"A record with that unique value already exists.":"The server could not complete the request.";
 res.status(status).json({error:msg});
});
// Upgrade path: a single-shop install (an existing shop.db with users) becomes the first shop, code "main", with its data untouched.
(function importLegacyShop(){
 try{
  if(master.prepare("SELECT COUNT(*) n FROM shops").get().n||!fs.existsSync(DB_PATH))return;
  const probe=new Database(DB_PATH,{readonly:true});let has=false,name="My Shop";
  try{has=probe.prepare("SELECT COUNT(*) n FROM users").get().n>0;const r=probe.prepare("SELECT value FROM settings WHERE key='business_name'").get();if(r?.value)name=r.value}catch{}
  probe.close();if(!has)return;
  master.prepare("INSERT INTO shops(slug,name,db_file,plan) VALUES('main',?,?,'legacy')").run(name,path.resolve(DB_PATH));
  console.log('Existing single-shop database registered as shop code "main".');
 }catch(e){console.error("Legacy shop import skipped:",e.message)}
})();
app.listen(PORT,()=>console.log(`SHOPFLOW listening on ${PORT}`));
