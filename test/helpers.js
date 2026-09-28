'use strict';
// Boots a real server.js on a throwaway port and database, so the tests
// exercise the actual HTTP surface rather than a re-implementation of it.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SERVER = path.join(__dirname, '..', 'server.js');

function freePort() {
  // Random high port; collisions are retried by startServer.
  return 20000 + Math.floor(Math.random() * 30000);
}

/**
 * @param {object} [env] extra environment for the server process
 * @returns {Promise<{base:string, stop:Function, dbPath:string, readDb:Function}>}
 */
async function startServer(env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ettest-'));
  const dbPath = path.join(dir, 'db.json');

  for (let attempt = 0; attempt < 5; attempt++) {
    const port = freePort();
    const child = spawn(process.execPath, [SERVER], {
      env: {
        ...process.env,
        PORT: String(port),
        DB_PATH: dbPath,
        DATABASE_URL: '',           // force the file store, never a real database
        ANTHROPIC_API_KEY: '',
        RESEND_API_KEY: env.RESEND_API_KEY ?? '',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const ready = await new Promise(resolve => {
      let out = '';
      const onData = d => {
        out += String(d);
        if (out.includes('running at')) resolve(true);
        if (/EADDRINUSE/.test(out)) resolve(false);
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.on('exit', () => resolve(false));
      setTimeout(() => resolve(false), 8000);
    });

    if (ready) {
      return {
        base: `http://127.0.0.1:${port}`,
        dbPath,
        // saveDB() debounces by 150ms, so the file may not exist yet. Wait for it
        // rather than making every caller remember to sleep first.
        readDb: () => waitForDb(dbPath),
        async stop() {
          child.kill('SIGKILL');
          try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
        },
      };
    }
    child.kill('SIGKILL');
  }
  throw new Error('could not start server on a free port');
}

/** Reads the persisted database, waiting out the save debounce. */
async function waitForDb(dbPath, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { return JSON.parse(fs.readFileSync(dbPath, 'utf8')); }
    catch (e) {
      if (Date.now() > deadline) throw e;
      await new Promise(r => setTimeout(r, 50));
    }
  }
}

/** Minimal cookie-aware client, so session behaviour is exercised for real. */
function client(base) {
  let cookie = '';
  return {
    get cookie() { return cookie; },
    set cookie(v) { cookie = v; },
    async req(method, urlPath, body, opts = {}) {
      const headers = { ...(opts.headers || {}) };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (cookie && !opts.noCookie) headers.Cookie = cookie;
      const r = await fetch(base + urlPath, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const setCookie = r.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      let json = null;
      const text = await r.text();
      try { json = JSON.parse(text); } catch { /* not json */ }
      return { status: r.status, json, text, headers: r.headers };
    },
    get(p, o) { return this.req('GET', p, undefined, o); },
    post(p, b, o) { return this.req('POST', p, b, o); },
    patch(p, b, o) { return this.req('PATCH', p, b, o); },
    del(p, b, o) { return this.req('DELETE', p, b, o); },
  };
}

/** saveDB() debounces by 150ms — wait before reading the file. */
const flushed = (ms = 400) => new Promise(r => setTimeout(r, ms));

module.exports = { startServer, client, flushed };
