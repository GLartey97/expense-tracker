'use strict';
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, client } = require('./helpers');

describe('security headers', () => {
  let srv, api;
  before(async () => { srv = await startServer(); api = client(srv.base); });
  after(async () => { await srv.stop(); });

  test('sets CSP, nosniff, referrer and frame policy', async () => {
    const r = await api.get('/api/health');
    assert.match(r.headers.get('content-security-policy') || '', /default-src 'self'/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('referrer-policy'), 'same-origin');
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
  });

  test('CSP allows only the font host it needs', async () => {
    const csp = (await api.get('/api/health')).headers.get('content-security-policy');
    assert.match(csp, /font-src [^;]*fonts\.gstatic\.com/);
    assert.match(csp, /connect-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
  });

  test('HSTS only when the request arrived over https', async () => {
    const plain = await api.get('/api/health');
    assert.equal(plain.headers.get('strict-transport-security'), null,
      'HSTS must not be sent over plain http');

    const proxied = await api.get('/api/health', { headers: { 'X-Forwarded-Proto': 'https' } });
    assert.match(proxied.headers.get('strict-transport-security') || '', /max-age=\d+/);
  });
});

describe('static file guard', () => {
  let srv, api;
  before(async () => { srv = await startServer(); api = client(srv.base); });
  after(async () => { await srv.stop(); });

  test('never serves the server source or the database', async () => {
    for (const p of ['/server.js', '/package.json', '/data/db.json']) {
      const r = await api.get(p);
      assert.notEqual(r.status, 200, `${p} should not be served`);
    }
  });

  test('resists path traversal', async () => {
    for (const p of ['/../server.js', '/..%2fserver.js', '/%2e%2e/%2e%2e/etc/passwd']) {
      const r = await api.get(p);
      assert.ok(r.status === 403 || r.status === 404, `${p} returned ${r.status}`);
      assert.ok(!/const ROOT|require\(/.test(r.text), `${p} leaked source`);
    }
  });

  test('unknown api routes 404 rather than falling through to a file', async () => {
    const r = await api.get('/api/definitely-not-a-route');
    assert.equal(r.status, 404);
  });
});

describe('request body limits', () => {
  let srv, api;
  before(async () => {
    srv = await startServer();
    api = client(srv.base);
    await api.post('/api/register', { username: 'judy', password: 'judypass1' });
  });
  after(async () => { await srv.stop(); });

  test('malformed JSON is rejected, not crashed on', async () => {
    const r = await fetch(srv.base + '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json at all',
    });
    assert.ok(r.status >= 400 && r.status < 500, `got ${r.status}`);
    // and the server is still answering
    assert.equal((await api.get('/api/health')).status, 200);
  });
});
