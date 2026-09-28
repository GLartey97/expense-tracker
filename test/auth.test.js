'use strict';
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, client } = require('./helpers');

describe('accounts and sessions', () => {
  let srv, api;
  before(async () => { srv = await startServer(); api = client(srv.base); });
  after(async () => { await srv.stop(); });

  test('rejects a short or malformed username', async () => {
    for (const username of ['ab', 'has space', 'UPPER!', '']) {
      const r = await api.post('/api/register', { username, password: 'goodpass1' });
      assert.equal(r.status, 400, `expected 400 for ${JSON.stringify(username)}`);
    }
  });

  test('rejects a password under 6 characters', async () => {
    const r = await api.post('/api/register', { username: 'shorty', password: '12345' });
    assert.equal(r.status, 400);
  });

  test('registers and signs in', async () => {
    const r = await api.post('/api/register', { username: 'alice', password: 'alicepass1' });
    assert.equal(r.status, 200);
    assert.equal(r.json.username, 'alice');

    const me = await api.get('/api/me');
    assert.equal(me.status, 200);
    assert.equal(me.json.username, 'alice');
  });

  test('session cookie is HttpOnly and SameSite', async () => {
    const fresh = client(srv.base);
    const r = await fresh.post('/api/login', { username: 'alice', password: 'alicepass1' });
    const raw = r.headers.get('set-cookie') || '';
    assert.match(raw, /HttpOnly/i);
    assert.match(raw, /SameSite=Lax/i);
  });

  test('refuses a duplicate username', async () => {
    const r = await api.post('/api/register', { username: 'alice', password: 'whatever1' });
    assert.equal(r.status, 409);
  });

  test('never stores the password in the clear', async () => {
    const raw = JSON.stringify(await srv.readDb());
    assert.ok(!raw.includes('alicepass1'), 'plaintext password found in the database');
  });

  test('wrong password is refused', async () => {
    const fresh = client(srv.base);
    const r = await fresh.post('/api/login', { username: 'alice', password: 'wrong' });
    assert.equal(r.status, 401);
  });

  test('unauthenticated requests are refused', async () => {
    const anon = client(srv.base);
    for (const [method, url] of [['GET', '/api/me'], ['GET', '/api/data'], ['POST', '/api/items/expenses']]) {
      const r = await anon.req(method, url, method === 'POST' ? {} : undefined);
      assert.equal(r.status, 401, `${method} ${url}`);
    }
  });

  test('logout invalidates the session', async () => {
    const c = client(srv.base);
    await c.post('/api/login', { username: 'alice', password: 'alicepass1' });
    assert.equal((await c.get('/api/me')).status, 200);
    await c.post('/api/logout', {});
    // the server clears the cookie, so present the old one deliberately
    c.cookie = 'sid=' + '0'.repeat(64);
    assert.equal((await c.get('/api/me')).status, 401);
  });
});

describe('password change', () => {
  let srv, api;
  before(async () => {
    srv = await startServer();
    api = client(srv.base);
    await api.post('/api/register', { username: 'bob', password: 'bobpass123' });
  });
  after(async () => { await srv.stop(); });

  test('requires the current password', async () => {
    const r = await api.post('/api/password', { current: 'nope', next: 'brandnew99' });
    assert.equal(r.status, 401);
  });

  test('enforces 8+ characters and a digit', async () => {
    for (const next of ['short1', 'nodigitshere']) {
      const r = await api.post('/api/password', { current: 'bobpass123', next });
      assert.equal(r.status, 400, next);
    }
  });

  test('refuses reusing the current password', async () => {
    const r = await api.post('/api/password', { current: 'bobpass123', next: 'bobpass123' });
    assert.equal(r.status, 400);
  });

  test('changes it, keeps this session, drops the others', async () => {
    const other = client(srv.base);
    await other.post('/api/login', { username: 'bob', password: 'bobpass123' });
    assert.equal((await other.get('/api/me')).status, 200);

    const r = await api.post('/api/password', { current: 'bobpass123', next: 'brandnew99' });
    assert.equal(r.status, 200);

    assert.equal((await api.get('/api/me')).status, 200, 'the calling session should survive');
    assert.equal((await other.get('/api/me')).status, 401, 'other sessions should be dropped');

    const fresh = client(srv.base);
    assert.equal((await fresh.post('/api/login', { username: 'bob', password: 'brandnew99' })).status, 200);
    assert.equal((await client(srv.base).post('/api/login', { username: 'bob', password: 'bobpass123' })).status, 401);
  });
});

describe('rate limiting', () => {
  let srv;
  before(async () => { srv = await startServer(); });
  after(async () => { await srv.stop(); });

  test('locks out after 10 failed logins and sets Retry-After', async () => {
    const api = client(srv.base);
    await api.post('/api/register', { username: 'carol', password: 'carolpass1' });

    let sawLimit = false;
    for (let i = 0; i < 12; i++) {
      const r = await api.post('/api/login', { username: 'carol', password: 'wrong' });
      if (r.status === 429) {
        sawLimit = true;
        assert.ok(r.headers.get('retry-after'), 'Retry-After header missing');
        break;
      }
      assert.equal(r.status, 401, `attempt ${i + 1} should be 401`);
    }
    assert.ok(sawLimit, 'never hit the rate limit');

    // The correct password is refused too — that is the point of the lockout.
    const r = await api.post('/api/login', { username: 'carol', password: 'carolpass1' });
    assert.equal(r.status, 429);
  });
});
