// Serveur de test local SANS wrangler : exécute le Worker sous Node 22 avec une
// base SQLite (node:sqlite) qui imite l'API D1, et sert /public comme Workers Assets.
// Usage : node scripts/local-server.mjs [port]
// Variables : DB_PATH (défaut :memory:), BILLING=off, STRIPE_MOCK=1
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'public');
const port = Number(process.argv[2] || process.env.PORT || 8787);

// ---------- Shim D1 ----------
class Stmt {
  constructor(db, sql, args = []) { this.db = db; this.sql = sql; this.args = args; }
  bind(...args) {
    args.forEach((a, i) => {
      if (a === undefined) throw new Error(`D1_TYPE_ERROR: undefined bind at ${i} for: ${this.sql.slice(0, 60)}`);
      if (typeof a === 'boolean' || (typeof a === 'object' && a !== null)) {
        throw new Error(`D1_TYPE_ERROR: unsupported type ${typeof a} at ${i}`);
      }
    });
    return new Stmt(this.db, this.sql, args);
  }
  _exec() {
    const s = this.db.prepare(this.sql);
    if (/^\s*select/i.test(this.sql)) return { results: s.all(...this.args).map((r) => ({ ...r })), success: true, meta: {} };
    const info = s.run(...this.args);
    return { results: [], success: true, meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
  }
  async first(col) {
    const r = this.db.prepare(this.sql).get(...this.args);
    if (!r) return null;
    return col ? r[col] : { ...r };
  }
  async all() { return { results: this.db.prepare(this.sql).all(...this.args).map((r) => ({ ...r })), success: true, meta: {} }; }
  async run() { return this._exec(); }
}
class D1Shim {
  constructor(file) {
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA foreign_keys = ON');
  }
  prepare(sql) { return new Stmt(this.db, sql); }
  async batch(stmts) {
    this.db.exec('BEGIN');
    try {
      const out = stmts.map((s) => s._exec());
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
}

const db = new D1Shim(process.env.DB_PATH || ':memory:');
for (const f of fs.readdirSync(path.join(root, 'migrations')).sort()) {
  db.db.exec(fs.readFileSync(path.join(root, 'migrations', f), 'utf8'));
}

// ---------- Shim ASSETS (html_handling auto-trailing-slash + 404-page + _headers) ----------
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};
function parseHeadersFile() {
  const file = path.join(publicDir, '_headers');
  if (!fs.existsSync(file)) return {};
  const rules = {};
  let current = null;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line)) { current = line.trim(); rules[current] = {}; continue; }
    const i = line.indexOf(':');
    if (current && i > 0) rules[current][line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return rules;
}
function headersFor(pathname) {
  const out = {};
  for (const [pattern, hdrs] of Object.entries(parseHeadersFile())) {
    const re = new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
    if (re.test(pathname)) Object.assign(out, hdrs);
  }
  return out;
}
function resolveAsset(pathname) {
  const clean = path.normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
  const candidates = clean.endsWith('/')
    ? [path.join(clean, 'index.html')]
    : [clean, `${clean}.html`, path.join(clean, 'index.html')];
  for (const c of candidates) {
    const full = path.join(publicDir, c);
    if (!full.startsWith(publicDir)) continue;
    if (path.basename(full).startsWith('_')) continue;
    if (fs.existsSync(full) && fs.statSync(full).isFile()) return full;
  }
  return null;
}
const ASSETS = {
  async fetch(request) {
    const url = new URL(request.url);
    const file = resolveAsset(url.pathname);
    const extra = headersFor(url.pathname);
    if (!file) {
      const nf = path.join(publicDir, '404.html');
      return new Response(fs.existsSync(nf) ? fs.readFileSync(nf) : 'Not found', {
        status: 404, headers: { 'content-type': TYPES['.html'], ...extra },
      });
    }
    return new Response(fs.readFileSync(file), {
      headers: { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', ...extra },
    });
  },
};

// ---------- Mock Stripe (tests) ----------
const mockSubs = new Map();
if (process.env.STRIPE_MOCK) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const u = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (u.hostname !== 'api.stripe.com') return realFetch(input, init);
    const method = (init.method || 'GET').toUpperCase();
    const ok = (data) => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
    if (method === 'POST' && u.pathname === '/v1/checkout/sessions') {
      const params = new URLSearchParams(init.body);
      globalThis.__lastCheckout = Object.fromEntries(params);
      return ok({ id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' });
    }
    if (method === 'POST' && u.pathname === '/v1/billing_portal/sessions') return ok({ url: 'https://billing.stripe.com/p/session/test' });
    const subMatch = u.pathname.match(/^\/v1\/subscriptions\/([^/]+)$/);
    if (subMatch && method === 'GET') {
      const sub = mockSubs.get(subMatch[1]);
      return sub ? ok(sub) : new Response(JSON.stringify({ error: { message: 'No such subscription' } }), { status: 404 });
    }
    if (subMatch && method === 'DELETE') {
      const sub = mockSubs.get(subMatch[1]);
      if (sub) sub.status = 'canceled';
      return ok({ id: subMatch[1], status: 'canceled' });
    }
    return new Response(JSON.stringify({ error: { message: `mock: unhandled ${method} ${u.pathname}` } }), { status: 400 });
  };
}

const billingOn = process.env.BILLING !== 'off';
const env = {
  DB: db,
  ASSETS,
  APP_URL: '',
  TRIAL_DAYS: process.env.TRIAL_DAYS || '14',
  FOUNDER_SEATS: '10',
  PRICE_MONTHLY_CENTS: '2900',
  SUPPORT_EMAIL: 'aide@exemple.ca',
  LEGAL_NAME: 'Responsable Test',
  STRIPE_AUTOMATIC_TAX: 'false',
  ADMIN_TOKEN: 'test-admin-token-0123456789abcdef',
  STRIPE_SECRET_KEY: billingOn ? 'sk_test_mock' : '',
  STRIPE_PRICE_ID: billingOn ? 'price_mock' : '',
  STRIPE_WEBHOOK_SECRET: billingOn ? 'whsec_test_secret' : '',
};

const server = http.createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const url = `http://${req.headers.host}${req.url}`;

    // Endpoints de pilotage des tests (jamais dans le Worker réel)
    if (req.url === '/__mock/stripe-sub' && req.method === 'POST') {
      const sub = JSON.parse(body.toString());
      mockSubs.set(sub.id, sub);
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
      return;
    }
    if (req.url === '/__mock/last-checkout') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(globalThis.__lastCheckout || null));
      return;
    }
    if (req.url === '/__mock/sql' && req.method === 'POST') {
      const { sql, args } = JSON.parse(body.toString());
      const out = db.db.prepare(sql).run(...(args || []));
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ changes: Number(out.changes) }));
      return;
    }

    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
    headers.set('cf-connecting-ip', req.socket.remoteAddress || '127.0.0.1');
    const request = new Request(url, {
      method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
    });
    const response = await worker.fetch(request, env, { waitUntil() {} });
    const outHeaders = {};
    response.headers.forEach((v, k) => { if (k !== 'set-cookie') outHeaders[k] = v; });
    const cookies = response.headers.getSetCookie();
    if (cookies.length) outHeaders['set-cookie'] = cookies;
    res.writeHead(response.status, outHeaders);
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (err) {
    console.error(err);
    res.writeHead(500).end('harness error');
  }
});
server.listen(port, () => console.log(`Soumission Pro (local) → http://localhost:${port}  billing=${billingOn ? 'on' : 'off'}`));
