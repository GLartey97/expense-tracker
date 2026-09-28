// Expense Tracker backend.
//   - Static file serving (index.html, login.html, assets)
//   - User accounts (register / login / logout / me / password) with scrypt-hashed passwords
//   - Per-user data persistence (expenses / income / wishlist)
//   - AI Advisor proxy to the Claude API (POST /api/advice)
//
// Storage is a single JSON file (data/db.json) — fine for a personal, single-host app.
// Run:  node server.js   ->   http://localhost:5173
// The Advisor needs an Anthropic API key:  set ANTHROPIC_API_KEY before launching.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;

// ── Load .env (zero-dependency) — lets deployers set ANTHROPIC_API_KEY in a file ──
(function loadEnv() {
  try {
    const text = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (!m) continue;
      const key = m[1];
      let val = m[2].trim().replace(/^['"]|['"]$/g, '');
      if (!(key in process.env)) process.env[key] = val;
    }
  } catch { /* no .env file — that's fine */ }
})();
const PORT = process.env.PORT || 5173;
// Overridable so the test suite can point at a throwaway file instead of the
// real store. Unset in production, where it falls back to data/db.json.
const DB_PATH = process.env.DB_PATH || path.join(ROOT, 'data', 'db.json');
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
// Arrays the whole-blob endpoint accepts. The three entry lists are also
// writable per-row via /api/items; categories are here because they are small
// and edited rarely.
const DATA_KEYS = ['cowork_expenses_v1', 'cowork_income_v1', 'cowork_wishlist_v1', 'cowork_categories_v1'];
// Preferences are an object, not an array, so they get their own allowance.
const DATA_OBJECT_KEYS = ['cowork_prefs_v1'];

// ── Password recovery (Resend) ──
// Without a key the endpoints still answer honestly rather than pretending a
// mail went out. Set RESEND_API_KEY and MAIL_FROM in the Render dashboard.
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const MAIL_FROM = process.env.MAIL_FROM || 'Expense Tracker <onboarding@resend.dev>';
const RESET_TTL_MS = 30 * 60 * 1000; // 30 minutes
const mailEnabled = () => Boolean(RESEND_API_KEY);

/** Public origin for links in emails; Render sets RENDER_EXTERNAL_URL. */
function appUrl(req) {
  const configured = process.env.APP_URL || process.env.RENDER_EXTERNAL_URL;
  if (configured) return String(configured).replace(/\/+$/, '');
  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  return `${proto}://${req.headers.host}`;
}

async function sendMail(to, subject, text) {
  if (!mailEnabled()) return { ok: false, reason: 'no-key' };
  try {
    // Overridable so the test suite can point at a local catcher. Unset in
    // production, where it falls back to Resend proper.
    const r = await fetch(process.env.RESEND_URL || 'https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: MAIL_FROM, to: [to], subject, text }),
    });
    if (r.ok) return { ok: true };
    const body = await r.text().catch(() => '');
    console.warn('[mail] Resend refused:', r.status, body.slice(0, 200));
    return { ok: false, reason: 'refused' };
  } catch (e) {
    console.warn('[mail] Resend unreachable:', e.message);
    return { ok: false, reason: 'unreachable' };
  }
}

// Tokens are stored hashed, so a leaked database still can't be used to reset
// anyone's password.
const hashToken = t => crypto.createHash('sha256').update(String(t)).digest('hex');
const normEmail = e => String(e || '').trim().toLowerCase();
const looksLikeEmail = e => /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(e);

// ── Anthropic SDK (optional — Advisor degrades gracefully without a key) ──
let anthropic = null;
try {
  const Anthropic = require('@anthropic-ai/sdk');
  if (process.env.ANTHROPIC_API_KEY) anthropic = new Anthropic();
} catch (e) {
  console.warn('[advisor] @anthropic-ai/sdk not installed — run `npm install`');
}

// ── Storage ──
// The whole state ({users, data, sessions}) is held in memory and persisted as
// one JSON blob. With DATABASE_URL set, it persists to Postgres (survives restarts —
// required on hosts with ephemeral disks like Render free). Without it, falls back
// to a local data/db.json file so local dev needs zero setup.
const DATABASE_URL = process.env.DATABASE_URL;
let db = { users: {}, data: {}, sessions: {}, resets: {} };
let pgPool = null;

async function initDB() {
  if (DATABASE_URL) {
    const { Pool } = require('pg');
    const local = /@(localhost|127\.0\.0\.1)[:/]/.test(DATABASE_URL);
    pgPool = new Pool({ connectionString: DATABASE_URL, ssl: local ? false : { rejectUnauthorized: false } });
    await pgPool.query('CREATE TABLE IF NOT EXISTS app_state (id int PRIMARY KEY, data jsonb NOT NULL)');
    const r = await pgPool.query('SELECT data FROM app_state WHERE id = 1');
    if (r.rows.length) db = r.rows[0].data;
    else await pgPool.query('INSERT INTO app_state (id, data) VALUES (1, $1)', [db]);
    console.log('[db] Using Postgres — data persists across restarts.');
  } else {
    try { db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); } catch { /* fresh */ }
    console.log('[db] Using local file data/db.json. Set DATABASE_URL for persistent Postgres (e.g. on Render).');
  }
  db.users = db.users || {};
  db.data = db.data || {};
  db.sessions = db.sessions || {};
  db.resets = db.resets || {};
}

let saveTimer = null;
function saveDB() {
  // debounce so rapid edits don't thrash the store
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (pgPool) {
      pgPool.query('UPDATE app_state SET data = $1 WHERE id = 1', [db])
        .catch(e => console.error('[db] save failed:', e.message));
    } else {
      try {
        fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
        fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
      } catch (e) { console.error('[db] save failed:', e.message); }
    }
  }, 150);
}

// ── Passwords (scrypt) ──
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return salt + ':' + hash;
}
function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(password, salt, 64);
  const a = Buffer.from(hash, 'hex');
  return a.length === test.length && crypto.timingSafeEqual(a, test);
}

// ── Per-entry collections ──
// Same storage keys the front-ends already use, so existing data is untouched.
const COLLECTIONS = {
  expenses: 'cowork_expenses_v1',
  income: 'cowork_income_v1',
  wishlist: 'cowork_wishlist_v1',
};
const MAX_ITEMS = 20000;

// ── Rate limiting ──
// scrypt is deliberately expensive, so unlimited login attempts are both a
// brute-force hole and a way to pin the CPU. Single instance, so in-memory
// counters are enough; they reset on restart, which is acceptable here.
const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_MAX = 10;
const rateHits = new Map(); // key -> number[] (timestamps)

function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.socket.remoteAddress || 'unknown';
}

/** Returns seconds to wait, or 0 when the caller is under the limit. */
function rateLimit(key) {
  const now = Date.now();
  const hits = (rateHits.get(key) || []).filter(t => now - t < RATE_WINDOW_MS);
  if (hits.length >= RATE_MAX) {
    rateHits.set(key, hits);
    return Math.ceil((RATE_WINDOW_MS - (now - hits[0])) / 1000);
  }
  hits.push(now);
  rateHits.set(key, hits);
  return 0;
}
function rateClear(key) { rateHits.delete(key); }

// Keep the map from growing without bound on a long-running instance.
setInterval(() => {
  const now = Date.now();
  let dropped = 0;
  for (const [h, rec] of Object.entries(db.resets || {})) {
    if (!rec || rec.exp < now) { delete db.resets[h]; dropped++; }
  }
  if (dropped) saveDB();
  for (const [k, hits] of rateHits) {
    const live = hits.filter(t => now - t < RATE_WINDOW_MS);
    if (live.length) rateHits.set(k, live); else rateHits.delete(k);
  }
}, RATE_WINDOW_MS).unref();

// ── Sessions ──
function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.sessions[token] = { userId, createdAt: Date.now() };
  saveDB();
  return token;
}
function userFromReq(req) {
  const cookie = req.headers.cookie || '';
  const m = cookie.match(/(?:^|;\s*)sid=([a-f0-9]+)/);
  if (!m) return null;
  const sess = db.sessions[m[1]];
  if (!sess) return null;
  if (Date.now() - sess.createdAt > SESSION_TTL_MS) { delete db.sessions[m[1]]; saveDB(); return null; }
  const user = Object.values(db.users).find(u => u.id === sess.userId);
  return user ? { ...user, _token: m[1] } : null;
}

// ── HTTP helpers ──
function sendJSON(res, status, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => {
      data += c;
      if (data.length > 1e7) { reject(new Error('Body too large')); req.destroy(); } // 10 MB cap
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}
function sessionCookie(token) {
  return `sid=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
}

const ADVISOR_SYSTEM =
  'You are a friendly, concise personal finance advisor for a user in Ghana. ' +
  'All amounts are in Ghanaian Cedi (GHS, symbol ₵). Give warm, specific, actionable advice. ' +
  'Keep every response under 200 words. Do not use markdown headers or tables — plain short paragraphs and simple lists only.';

// ── Static files ──
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.webmanifest': 'application/manifest+json',
};
// Never served, however the URL is spelled.
const PRIVATE_FILES = new Set(['server.js', 'serve.js', 'package.json', 'package-lock.json', 'render.yaml']);
const PRIVATE_DIRS = ['data', 'node_modules', 'test', 'tools'];

function serveStatic(req, res, urlPath) {
  if (urlPath === '/' || urlPath === '') urlPath = '/index.html';
  // Resolve first, then judge the *resolved* path. Judging the raw URL let
  // "/../server.js" through, because normalize() collapses it to "/server.js".
  const filePath = path.resolve(ROOT, '.' + path.normalize('/' + urlPath));
  const rel = path.relative(ROOT, filePath);
  const first = rel.split(path.sep)[0];
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) ||
      filePath === DB_PATH || PRIVATE_FILES.has(rel) || PRIVATE_DIRS.includes(first) ||
      first.startsWith('.')) {            // .env, .git, .gitignore …
    res.writeHead(403); return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
}

// ── Security headers ──
// The pages are self-contained apart from Google Fonts and the Claude API, so
// the CSP can stay tight. 'unsafe-inline' is still needed because index.html,
// login.html and mobile.html carry inline <style>/<script>.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
].join('; ');

function securityHeaders(req, res) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  // Render terminates TLS in front of us, so only advertise HSTS when the
  // original request actually arrived over https.
  if (String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
}

// ── Server ──
const server = http.createServer(async (req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  securityHeaders(req, res);

  try {
    // ---- Health / diagnostics (no secrets) ----
    if (urlPath === '/api/health' && req.method === 'GET') {
      return sendJSON(res, 200, {
        ok: true,
        storage: pgPool ? 'postgres' : 'file',
        persistent: !!pgPool,
        accounts: Object.keys(db.users).length,
      });
    }

    // ---- Auth ----
    if (urlPath === '/api/register' && req.method === 'POST') {
      const regWait = rateLimit('reg:' + clientIp(req));
      if (regWait) {
        return sendJSON(res, 429, { error: `Too many attempts. Try again in ${Math.ceil(regWait / 60)} min.` },
          { 'Retry-After': String(regWait) });
      }
      const { username, password, email } = await readBody(req);
      const u = String(username || '').trim().toLowerCase();
      if (u.length < 3 || u.length > 32 || !/^[a-z0-9_.-]+$/.test(u))
        return sendJSON(res, 400, { error: 'Username must be 3–32 chars: letters, numbers, _ . -' });
      if (String(password || '').length < 6)
        return sendJSON(res, 400, { error: 'Password must be at least 6 characters.' });
      if (db.users[u]) return sendJSON(res, 409, { error: 'That username is taken.' });
      const id = crypto.randomUUID();
      const regEmail = normEmail(email);
      if (regEmail && !looksLikeEmail(regEmail))
        return sendJSON(res, 400, { error: 'That does not look like an email address.' });
      db.users[u] = { id, username: u, password: hashPassword(password), email: regEmail || null, createdAt: Date.now() };
      db.data[id] = {};
      const token = createSession(id);
      return sendJSON(res, 200, { username: u }, { 'Set-Cookie': sessionCookie(token) });
    }

    if (urlPath === '/api/login' && req.method === 'POST') {
      const { username, password } = await readBody(req);
      const u = String(username || '').trim().toLowerCase();
      // Limit per IP and per account, so neither one machine spraying accounts
      // nor many machines targeting one account gets unlimited attempts.
      const wait = rateLimit('ip:' + clientIp(req)) || rateLimit('user:' + u);
      if (wait) {
        return sendJSON(res, 429, { error: `Too many attempts. Try again in ${Math.ceil(wait / 60)} min.` },
          { 'Retry-After': String(wait) });
      }
      const user = db.users[u];
      if (!user || !verifyPassword(String(password || ''), user.password))
        return sendJSON(res, 401, { error: 'Wrong username or password.' });
      rateClear('ip:' + clientIp(req));
      rateClear('user:' + u);
      const token = createSession(user.id);
      return sendJSON(res, 200, { username: user.username }, { 'Set-Cookie': sessionCookie(token) });
    }

    if (urlPath === '/api/password' && req.method === 'POST') {
      const user = userFromReq(req);
      if (!user) return sendJSON(res, 401, { error: 'Not signed in' });
      const pwWait = rateLimit('pw:' + user.id);
      if (pwWait) {
        return sendJSON(res, 429, { error: `Too many attempts. Try again in ${Math.ceil(pwWait / 60)} min.` },
          { 'Retry-After': String(pwWait) });
      }
      const { current, next } = await readBody(req);
      // Knowing the session is not enough to take the account over.
      if (!verifyPassword(String(current || ''), user.password))
        return sendJSON(res, 401, { error: 'Current password is wrong.' });
      rateClear('pw:' + user.id);
      const np = String(next || '');
      if (np.length < 8 || !/\d/.test(np))
        return sendJSON(res, 400, { error: 'New password needs 8+ characters and a number.' });
      if (verifyPassword(np, user.password))
        return sendJSON(res, 400, { error: 'That is already your password.' });

      // userFromReq returns a copy — write through the stored record.
      db.users[user.username].password = hashPassword(np);
      // Drop every other session, so a stolen cookie dies with the change.
      for (const [token, sess] of Object.entries(db.sessions)) {
        if (sess.userId === user.id && token !== user._token) delete db.sessions[token];
      }
      saveDB();
      return sendJSON(res, 200, { ok: true });
    }

    // ---- Recovery email on the account ----
    if (urlPath === '/api/email' && req.method === 'POST') {
      const user = userFromReq(req);
      if (!user) return sendJSON(res, 401, { error: 'Not signed in' });
      const { email, password } = await readBody(req);
      // Changing where a reset lands is as sensitive as changing the password.
      if (!verifyPassword(String(password || ''), user.password))
        return sendJSON(res, 401, { error: 'Password is wrong.' });
      const e = normEmail(email);
      if (e && !looksLikeEmail(e))
        return sendJSON(res, 400, { error: 'That does not look like an email address.' });
      if (e && Object.values(db.users).some(u => u.id !== user.id && normEmail(u.email) === e))
        return sendJSON(res, 409, { error: 'That email is already on another account.' });
      db.users[user.username].email = e || null;
      saveDB();
      return sendJSON(res, 200, { email: e || null, mailEnabled: mailEnabled() });
    }

    if (urlPath === '/api/email' && req.method === 'GET') {
      const user = userFromReq(req);
      if (!user) return sendJSON(res, 401, { error: 'Not signed in' });
      return sendJSON(res, 200, { email: user.email || null, mailEnabled: mailEnabled() });
    }

    // ---- Forgot / reset ----
    if (urlPath === '/api/forgot' && req.method === 'POST') {
      const wait = rateLimit('forgot:' + clientIp(req));
      if (wait) {
        return sendJSON(res, 429, { error: `Too many attempts. Try again in ${Math.ceil(wait / 60)} min.` },
          { 'Retry-After': String(wait) });
      }
      const { account } = await readBody(req);
      const q = String(account || '').trim().toLowerCase();
      const user = db.users[q] || Object.values(db.users).find(u => normEmail(u.email) === q);

      if (user && user.email) {
        const token = crypto.randomBytes(32).toString('hex');
        db.resets[hashToken(token)] = { userId: user.id, exp: Date.now() + RESET_TTL_MS };
        saveDB();
        const link = `${appUrl(req)}/reset.html?token=${token}`;
        await sendMail(user.email,
          'Reset your Expense Tracker password',
          `Someone asked to reset the password for "${user.username}".\n\n` +
          `Open this link within 30 minutes to choose a new one:\n${link}\n\n` +
          `If that wasn't you, ignore this email — nothing has changed.`);
      }
      // Always the same answer, so this can't be used to discover who has an
      // account or which addresses are registered.
      return sendJSON(res, 200, {
        ok: true,
        mailEnabled: mailEnabled(),
        message: mailEnabled()
          ? 'If that account has a recovery email, a reset link is on its way.'
          : 'Password reset email is not configured on this server yet.',
      });
    }

    if (urlPath === '/api/reset' && req.method === 'POST') {
      const wait = rateLimit('reset:' + clientIp(req));
      if (wait) {
        return sendJSON(res, 429, { error: `Too many attempts. Try again in ${Math.ceil(wait / 60)} min.` },
          { 'Retry-After': String(wait) });
      }
      const { token, password } = await readBody(req);
      const rec = db.resets[hashToken(token || '')];
      if (!rec || rec.exp < Date.now()) {
        if (rec) { delete db.resets[hashToken(token)]; saveDB(); }
        return sendJSON(res, 400, { error: 'That reset link has expired or already been used.' });
      }
      const np = String(password || '');
      if (np.length < 8 || !/\d/.test(np))
        return sendJSON(res, 400, { error: 'New password needs 8+ characters and a number.' });

      const user = Object.values(db.users).find(u => u.id === rec.userId);
      if (!user) return sendJSON(res, 400, { error: 'That account no longer exists.' });

      db.users[user.username].password = hashPassword(np);
      delete db.resets[hashToken(token)];               // single use
      for (const [tok, sess] of Object.entries(db.sessions)) {
        if (sess.userId === user.id) delete db.sessions[tok]; // sign out everywhere
      }
      saveDB();
      return sendJSON(res, 200, { ok: true, username: user.username });
    }

    if (urlPath === '/api/logout' && req.method === 'POST') {
      const user = userFromReq(req);
      if (user && user._token) { delete db.sessions[user._token]; saveDB(); }
      return sendJSON(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; HttpOnly; Path=/; Max-Age=0' });
    }

    if (urlPath === '/api/me' && req.method === 'GET') {
      const user = userFromReq(req);
      if (!user) return sendJSON(res, 401, { error: 'Not signed in' });
      return sendJSON(res, 200, { username: user.username });
    }

    // ---- Per-entry writes ----
    // /api/data replaces a whole array, so two devices saving at once means one
    // silently wins. These endpoints mutate a single row instead; Node handles
    // one request at a time, so concurrent edits from different devices merge
    // rather than clobber.
    if (urlPath.startsWith('/api/items/')) {
      const user = userFromReq(req);
      if (!user) return sendJSON(res, 401, { error: 'Not signed in' });

      const parts = urlPath.split('/').filter(Boolean); // api, items, <coll>, <id?>
      const key = COLLECTIONS[parts[2]];
      if (!key) return sendJSON(res, 404, { error: 'Unknown collection' });
      const id = parts[3] ? decodeURIComponent(parts[3]) : null;

      db.data[user.id] = db.data[user.id] || {};
      const list = Array.isArray(db.data[user.id][key]) ? db.data[user.id][key] : [];
      const idx = id === null ? -1 : list.findIndex(x => String(x && x.id) === String(id));

      if (req.method === 'POST') {
        if (list.length >= MAX_ITEMS)
          return sendJSON(res, 413, { error: `That list is full (${MAX_ITEMS} max).` });
        const body = await readBody(req);
        if (!body || typeof body !== 'object' || Array.isArray(body))
          return sendJSON(res, 400, { error: 'Expected an object.' });
        // The server owns ids unconditionally — honouring a client-supplied one
        // would let two offline devices mint the same id and collide.
        const item = { ...body, id: crypto.randomUUID() };
        list.push(item);
        db.data[user.id][key] = list;
        saveDB();
        return sendJSON(res, 200, { item });
      }

      if (req.method === 'PATCH') {
        if (idx < 0) return sendJSON(res, 404, { error: 'No such entry.' });
        const body = await readBody(req);
        if (!body || typeof body !== 'object' || Array.isArray(body))
          return sendJSON(res, 400, { error: 'Expected an object.' });
        const item = { ...list[idx], ...body, id: list[idx].id };
        list[idx] = item;
        db.data[user.id][key] = list;
        saveDB();
        return sendJSON(res, 200, { item });
      }

      if (req.method === 'DELETE') {
        // Already gone is a success — deleting twice shouldn't error.
        if (idx >= 0) {
          list.splice(idx, 1);
          db.data[user.id][key] = list;
          saveDB();
        }
        return sendJSON(res, 200, { ok: true });
      }

      return sendJSON(res, 405, { error: 'Method not allowed' });
    }

    // ---- Per-user data ----
    if (urlPath === '/api/data') {
      const user = userFromReq(req);
      if (!user) return sendJSON(res, 401, { error: 'Not signed in' });
      if (req.method === 'GET') return sendJSON(res, 200, db.data[user.id] || {});
      if (req.method === 'POST') {
        const { key, value } = await readBody(req);
        const isArrayKey = DATA_KEYS.includes(key);
        const isObjectKey = DATA_OBJECT_KEYS.includes(key);
        if (!isArrayKey && !isObjectKey) return sendJSON(res, 400, { error: 'Unknown data key' });
        if (isArrayKey && !Array.isArray(value))
          return sendJSON(res, 400, { error: 'Value must be an array' });
        if (isObjectKey && (value === null || typeof value !== 'object' || Array.isArray(value)))
          return sendJSON(res, 400, { error: 'Value must be an object' });
        db.data[user.id] = db.data[user.id] || {};
        db.data[user.id][key] = value;
        saveDB();
        return sendJSON(res, 200, { ok: true });
      }
    }

    // ---- AI Advisor ----
    if (urlPath === '/api/advice' && req.method === 'POST') {
      const user = userFromReq(req);
      if (!user) return sendJSON(res, 401, { error: 'Not signed in' });
      if (!anthropic)
        return sendJSON(res, 503, { error: 'AI advisor is not configured. Set ANTHROPIC_API_KEY and restart the server.' });
      const { prompt } = await readBody(req);
      if (!prompt || typeof prompt !== 'string')
        return sendJSON(res, 400, { error: 'Missing prompt' });
      try {
        const msg = await anthropic.messages.create({
          model: 'claude-opus-4-8',
          max_tokens: 1024,
          system: ADVISOR_SYSTEM,
          messages: [{ role: 'user', content: prompt }],
        });
        const text = msg.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
        return sendJSON(res, 200, { text });
      } catch (err) {
        console.error('[advisor]', err.message);
        return sendJSON(res, 502, { error: 'Advisor request failed: ' + err.message });
      }
    }

    if (urlPath.startsWith('/api/')) return sendJSON(res, 404, { error: 'Unknown endpoint' });

    // ---- Static ----
    return serveStatic(req, res, urlPath);
  } catch (err) {
    return sendJSON(res, 400, { error: err.message || 'Bad request' });
  }
});

initDB().then(() => {
  server.listen(PORT, () => {
    console.log(`Expense Tracker running at http://localhost:${PORT}`);
    console.log(anthropic
      ? '[advisor] Claude API key detected — Advisor is live.'
      : '[advisor] No ANTHROPIC_API_KEY — Advisor will show a "not configured" message until you set one.');

    // Keep-awake: on Render's free tier the service sleeps after ~15 min idle and
    // shows a cold-start page on the next visit. Pinging our own public URL every
    // 13 min counts as inbound traffic and keeps the instance warm. RENDER_EXTERNAL_URL
    // is injected by Render, so this only runs in that environment.
    const SELF_URL = process.env.RENDER_EXTERNAL_URL;
    if (SELF_URL && typeof fetch === 'function') {
      setInterval(() => { fetch(SELF_URL + '/api/health').catch(() => {}); }, 13 * 60 * 1000);
      console.log('[keep-awake] Pinging ' + SELF_URL + '/api/health every 13 min to prevent free-tier sleep.');
    }
  });
}).catch((err) => {
  console.error('[db] Startup failed — could not initialize storage:', err.message);
  process.exit(1);
});
