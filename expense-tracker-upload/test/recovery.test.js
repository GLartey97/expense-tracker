'use strict';
// Password recovery. A stub stands in for Resend so the emailed token can be
// read back and the whole loop exercised without sending anything.

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { startServer, client } = require('./helpers');

/** Captures what the server tries to send, and answers like Resend would. */
function mailCatcher() {
  const sent = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      try { sent.push(JSON.parse(body)); } catch { sent.push({ raw: body }); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"id":"stub"}');
    });
  });
  return {
    sent,
    last: () => sent[sent.length - 1],
    tokenFromLast() {
      const m = /token=([a-f0-9]+)/.exec(this.last().text || '');
      return m && m[1];
    },
    listen() {
      return new Promise(resolve => {
        server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}/`));
      });
    },
    close() { server.close(); },
  };
}

describe('recovery email', () => {
  let srv, api;
  before(async () => {
    srv = await startServer({ RESEND_API_KEY: 'stub-key' });
    api = client(srv.base);
    await api.post('/api/register', { username: 'frank', password: 'frankpass1' });
  });
  after(async () => { await srv.stop(); });

  test('starts unset', async () => {
    const r = await api.get('/api/email');
    assert.equal(r.status, 200);
    assert.equal(r.json.email, null);
  });

  test('setting it requires the account password', async () => {
    const r = await api.post('/api/email', { email: 'frank@example.com', password: 'wrong' });
    assert.equal(r.status, 401);
  });

  test('rejects a malformed address', async () => {
    const r = await api.post('/api/email', { email: 'not-an-email', password: 'frankpass1' });
    assert.equal(r.status, 400);
  });

  test('stores it normalised', async () => {
    const r = await api.post('/api/email', { email: '  Frank@Example.COM ', password: 'frankpass1' });
    assert.equal(r.status, 200);
    assert.equal(r.json.email, 'frank@example.com');
  });

  test('refuses an address already on another account', async () => {
    const other = client(srv.base);
    await other.post('/api/register', { username: 'grace', password: 'gracepass1' });
    const r = await other.post('/api/email', { email: 'frank@example.com', password: 'gracepass1' });
    assert.equal(r.status, 409);
  });

  test('can be cleared', async () => {
    assert.equal((await api.post('/api/email', { email: '', password: 'frankpass1' })).json.email, null);
    await api.post('/api/email', { email: 'frank@example.com', password: 'frankpass1' });
  });
});

describe('forgot and reset', () => {
  let srv, api, mail, mailUrl;

  before(async () => {
    mail = mailCatcher();
    mailUrl = await mail.listen();
    srv = await startServer({ RESEND_API_KEY: 'stub-key', RESEND_URL: mailUrl, APP_URL: 'https://example.test' });
    api = client(srv.base);
    await api.post('/api/register', { username: 'heidi', password: 'heidipass1' });
    await api.post('/api/email', { email: 'heidi@example.com', password: 'heidipass1' });
  });
  after(async () => { await srv.stop(); mail.close(); });

  test('reports that mail is configured', async () => {
    const r = await api.post('/api/forgot', { account: 'heidi' });
    assert.equal(r.status, 200);
    assert.equal(r.json.mailEnabled, true);
  });

  test('sends a link to the account address', async () => {
    assert.ok(mail.last(), 'no mail captured');
    assert.deepEqual(mail.last().to, ['heidi@example.com']);
    assert.match(mail.last().subject, /reset/i);
    assert.match(mail.last().text, /https:\/\/example\.test\/reset\.html\?token=[a-f0-9]+/);
  });

  test('works by email address too', async () => {
    const before = mail.sent.length;
    await api.post('/api/forgot', { account: 'HEIDI@example.com' });
    assert.equal(mail.sent.length, before + 1);
  });

  test('gives nothing away about unknown accounts', async () => {
    const known = await api.post('/api/forgot', { account: 'heidi' });
    const before = mail.sent.length;
    const unknown = await api.post('/api/forgot', { account: 'no-such-person' });
    assert.equal(unknown.status, known.status);
    assert.deepEqual(unknown.json, known.json, 'responses must be indistinguishable');
    assert.equal(mail.sent.length, before, 'no mail should be sent for an unknown account');
  });

  test('stores the token hashed, never in the clear', async () => {
    const token = mail.tokenFromLast();
    assert.ok(token, 'no token in the email');
    const raw = JSON.stringify(await srv.readDb());
    assert.ok(!raw.includes(token), 'raw reset token found in the database');
    const resets = (await srv.readDb()).resets || {};
    assert.ok(Object.keys(resets).every(k => /^[a-f0-9]{64}$/.test(k)), 'tokens should be sha256 hashes');
  });

  test('rejects a bad token', async () => {
    const r = await api.post('/api/reset', { token: 'deadbeef', password: 'newpass123' });
    assert.equal(r.status, 400);
  });

  test('enforces password rules on reset', async () => {
    await api.post('/api/forgot', { account: 'heidi' });
    const token = mail.tokenFromLast();
    for (const password of ['short1', 'nodigitspresent']) {
      assert.equal((await api.post('/api/reset', { token, password })).status, 400, password);
    }
  });

  test('resets the password, is single use, and signs out everywhere', async () => {
    const live = client(srv.base);
    await live.post('/api/login', { username: 'heidi', password: 'heidipass1' });
    assert.equal((await live.get('/api/me')).status, 200);

    await api.post('/api/forgot', { account: 'heidi' });
    const token = mail.tokenFromLast();

    const r = await api.post('/api/reset', { token, password: 'resetpass99' });
    assert.equal(r.status, 200);

    // single use
    assert.equal((await api.post('/api/reset', { token, password: 'againpass99' })).status, 400);

    // sessions dropped
    assert.equal((await live.get('/api/me')).status, 401);

    // credentials swapped
    const fresh = client(srv.base);
    assert.equal((await fresh.post('/api/login', { username: 'heidi', password: 'resetpass99' })).status, 200);
    assert.equal((await client(srv.base).post('/api/login', { username: 'heidi', password: 'heidipass1' })).status, 401);
  });
});

describe('without a Resend key', () => {
  let srv, api;
  before(async () => {
    srv = await startServer(); // no RESEND_API_KEY
    api = client(srv.base);
    await api.post('/api/register', { username: 'ivan', password: 'ivanpass1' });
    await api.post('/api/email', { email: 'ivan@example.com', password: 'ivanpass1' });
  });
  after(async () => { await srv.stop(); });

  test('says so plainly instead of pretending', async () => {
    const r = await api.post('/api/forgot', { account: 'ivan' });
    assert.equal(r.status, 200);
    assert.equal(r.json.mailEnabled, false);
    assert.match(r.json.message, /not configured/i);
  });
});
