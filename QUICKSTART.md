# SHOPFLOW — Quick start

Full stack: Node/Express API + SQLite (`server.js`), browser UI (`public/`), regression tests (`tests/`), Render config (`render.yaml`).

## Run locally (Windows, macOS or Linux; Node.js 20+)
```
npm install
cp .env.example .env      # Windows: copy .env.example .env
npm start
```
Open http://localhost:3000 and create the first administrator (password 10+ characters).

Note: `.env` is documentation only unless you load it; set variables in your shell or hosting dashboard
(PORT, DATABASE_PATH, NODE_ENV). Optional dev-only demo data: SEED_DEMO_DATA=true.

## Test
```
npm test
```

## Deploy on Render
Push to GitHub, then New > Blueprint (uses `render.yaml`: persistent disk at /var/data, NODE_ENV=production, Node 20). Then open the site and use Create a shop.
Persistent disks need a paid Render plan.

Dependencies are not bundled: `better-sqlite3` is a native module, so `npm install` must run on the machine that runs the app.
Read `MILESTONE_6_PHASE_10_FIXES_REPORT.md` before using it with real money.

Scanner and receipt printer setup: see "Barcode scanner and receipt printer" in README.md. `BUSINESS_NAME` in the environment is only the default shop name; change it any time under Settings.
