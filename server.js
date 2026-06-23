// Expense Tracker backend.
//   - Static file serving (index.html, login.html, assets)
//   - User accounts (register / login / logout / me) with scrypt-hashed passwords
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
const DB_PATH = path.join(ROOT, 'data', 'db.json');
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const DATA_KEYS = ['cowork_expenses_v1', 'cowork_income_v1', 'cowork_wishlist_v1'];

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
let db = { users: {}, data: {}, sessions: {} };
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
function serveStatic(req, res, urlPath) {
  if (urlPath === '/' || urlPath === '') urlPath = '/index.html';
  const filePath = path.join(ROOT, path.normalize(urlPath));
  // path-traversal guard + never serve the DB or server source
  if (!filePath.startsWith(ROOT) || filePath === DB_PATH ||
      ['/server.js', '/serve.js', '/package.json', '/package-lock.json'].includes(urlPath) ||
      urlPath.startsWith('/data') || urlPath.startsWith('/node_modules')) {
    res.writeHead(403); return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
}

// ── Server ──
const server = http.createServer(async (req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);

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
      const { username, password } = await readBody(req);
      const u = String(username || '').trim().toLowerCase();
      if (u.length < 3 || u.length > 32 || !/^[a-z0-9_.-]+$/.test(u))
        return sendJSON(res, 400, { error: 'Username must be 3–32 chars: letters, numbers, _ . -' });
      if (String(password || '').length < 6)
        return sendJSON(res, 400, { error: 'Password must be at least 6 characters.' });
      if (db.users[u]) return sendJSON(res, 409, { error: 'That username is taken.' });
      const id = crypto.randomUUID();
      db.users[u] = { id, username: u, password: hashPassword(password), createdAt: Date.now() };
      db.data[id] = {};
      const token = createSession(id);
      return sendJSON(res, 200, { username: u }, { 'Set-Cookie': sessionCookie(token) });
    }

    if (urlPath === '/api/login' && req.method === 'POST') {
      const { username, password } = await readBody(req);
      const u = String(username || '').trim().toLowerCase();
      const user = db.users[u];
      if (!user || !verifyPassword(String(password || ''), user.password))
        return sendJSON(res, 401, { error: 'Wrong username or password.' });
      const token = createSession(user.id);
      return sendJSON(res, 200, { username: user.username }, { 'Set-Cookie': sessionCookie(token) });
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

    // ---- Per-user data ----
    if (urlPath === '/api/data') {
      const user = userFromReq(req);
      if (!user) return sendJSON(res, 401, { error: 'Not signed in' });
      if (req.method === 'GET') return sendJSON(res, 200, db.data[user.id] || {});
      if (req.method === 'POST') {
        const { key, value } = await readBody(req);
        if (!DATA_KEYS.includes(key)) return sendJSON(res, 400, { error: 'Unknown data key' });
        if (!Array.isArray(value)) return sendJSON(res, 400, { error: 'Value must be an array' });
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
