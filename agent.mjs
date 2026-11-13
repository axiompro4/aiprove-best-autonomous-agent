// AIProve autonomous agent — no human in the loop.
// Reads skill.md, signs in with its own keypair, enters open bounties whose
// payloads it can produce honestly, submits, and reports. Free entries only.
//
// Run:  npm install && node agent.mjs [--dry-run]
import { Wallet } from "ethers";
import fs from "node:fs";
import path from "node:path";

const API = process.env.API_BASE_URL || "https://aiprove.fun";
const KEY_PATH = process.env.PG_KEYPAIR || path.join(process.env.HOME, ".pg", "agent.key");
const DRY = process.argv.includes("--dry-run");
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------- identity ----------
function loadOrCreateWallet() {
  if (fs.existsSync(KEY_PATH)) return new Wallet(fs.readFileSync(KEY_PATH, "utf8").trim());
  const w = Wallet.createRandom();
  fs.mkdirSync(path.dirname(KEY_PATH), { recursive: true, mode: 0o700 });
  fs.writeFileSync(KEY_PATH, w.privateKey, { mode: 0o600 });
  return w;
}
const wallet = loadOrCreateWallet();
log("identity:", wallet.address);

// ---------- auth ----------
let token = null;
async function auth() {
  const ch = await (await fetch(`${API}/api/auth/challenge?address=${wallet.address}`)).json();
  const signature = await wallet.signMessage(ch.challenge);
  const v = await (await fetch(`${API}/api/auth/verify`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ address: wallet.address, signature }),
  })).json();
  if (!v.token) throw new Error("auth failed: " + JSON.stringify(v));
  token = v.token;
  log("authenticated; session until", v.expiresAt);
}
async function call(method, p, body) {
  const r = await fetch(`${API}${p}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401 && token) { await auth(); return call(method, p, body); }
  const t = await r.text();
  try { return { status: r.status, json: JSON.parse(t) }; } catch { return { status: r.status, json: t }; }
}

// ---------- market data (public, no keys) ----------
// Binance public daily klines for a symbol like BTCUSDT.
async function dailyCloses(symbol, days = 30) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1d&limit=${days}`;
  const rows = await (await fetch(url)).json();
  return rows.map((r) => parseFloat(r[4]));
}
// Probability the next close is higher: base rate blended with 7d momentum.
function probUp(closes) {
  const n = closes.length;
  let ups = 0;
  for (let i = 1; i < n; i++) if (closes[i] > closes[i - 1]) ups++;
  const base = ups / (n - 1);                                    // empirical up-rate
  const mom = closes[n - 1] / closes[Math.max(0, n - 8)] - 1;    // 7d momentum
  const p = 0.65 * base + 0.35 * Math.min(0.85, Math.max(0.15, 0.5 + mom * 2.5));
  return Math.min(0.9, Math.max(0.1, p));
}

// ---------- bounty handlers ----------
// Each handler returns a submit payload or null (skip honestly).
const handlers = [
  {
    match: (b) => b.submitKind === "prediction" && /btc/i.test(b.slug) && /higher/i.test(b.brief || ""),
    run: async () => {
      const closes = await dailyCloses("BTCUSDT", 30);
      const p = probUp(closes);
      return { prediction: { answer: p >= 0.5 ? "yes" : "no", prob: +(p >= 0.5 ? p : 1 - p).toFixed(2) } };
    },
  },
  {
    // Generic fallback for yes/no crypto forecasts (eth etc.)
    match: (b) => b.submitKind === "prediction" && b.metric && /brier/i.test(b.metric),
    run: async (b) => {
      const sym = /eth/i.test(b.slug) ? "ETHUSDT" : "BTCUSDT";
      const closes = await dailyCloses(sym, 30);
      const p = probUp(closes);
      return { prediction: { answer: p >= 0.5 ? "yes" : "no", confidence: +(p >= 0.5 ? p : 1 - p).toFixed(2) } };
    },
  },
];

async function main() {
  await auth();
  const skill = await (await fetch(`${API}/skill.md`)).text();
  log("read skill.md:", skill.length, "bytes");
  const { json: list } = await call("GET", "/api/bounties?status=open");
  const bounties = Array.isArray(list) ? list : list.bounties || [];
  const me = (await call("GET", "/api/me")).json;
  const already = new Set((me.competing || []).map((c) => c.slug || c));
  log("open bounties:", bounties.length, "| already competing:", [...already].join(",") || "none");

  let entered = 0, submitted = 0, skipped = 0;
  for (const item of bounties) {
    const detail = (await call("GET", `/api/bounties/${item.slug}`)).json;
    const b = { ...detail.bounty, submitKind: detail.submitKind };
    if (already.has(b.slug)) { skipped++; continue; }
    const h = handlers.find((x) => x.match(b));
    if (!h) { log("skip (no honest payload):", b.slug); skipped++; continue; }
    const payload = await h.run(b).catch((e) => { log("handler error", b.slug, e.message); return null; });
    if (!payload) { skipped++; continue; }
    if (DRY) { log("dry-run would submit", b.slug, JSON.stringify(payload)); submitted++; continue; }
    const en = await call("POST", `/api/bounties/${b.slug}/enter`, { handle: "autonomous.agent" });
    if (en.status === 201) entered++;
    const sub = await call("POST", `/api/bounties/${b.slug}/submit`, { ...payload, handle: "autonomous.agent" });
    log("submit", b.slug, "->", sub.status, sub.json && sub.json.id ? sub.json.id : JSON.stringify(sub.json).slice(0, 120));
    if (sub.status === 201) submitted++;
  }
  const after = (await call("GET", "/api/me")).json;
  log(`done. entered=${entered} submitted=${submitted} skipped=${skipped}`);
  log("competing now:", JSON.stringify(after.competing || []));
}
main().catch((e) => { console.error("FATAL", e); process.exit(1); });
