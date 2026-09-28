'use strict';
// The per-entry endpoints exist to stop one device's save wiping another's.
// These tests pin that behaviour down.

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, client, flushed } = require('./helpers');

const EXP = 'cowork_expenses_v1';
const expense = (desc, amount = 10) => ({ date: '2026-09-28', amount, category: 'Shopping', desc });

describe('per-entry writes', () => {
  let srv, api;
  before(async () => {
    srv = await startServer();
    api = client(srv.base);
    await api.post('/api/register', { username: 'dave', password: 'davepass1' });
  });
  after(async () => { await srv.stop(); });

  const listExpenses = async () => (await api.get('/api/data')).json[EXP] || [];

  test('creates an entry and assigns a server id', async () => {
    const r = await api.post('/api/items/expenses', expense('Coffee'));
    assert.equal(r.status, 200);
    assert.ok(r.json.item.id, 'no id returned');
    assert.equal(r.json.item.desc, 'Coffee');
  });

  test('ignores a client-supplied id', async () => {
    // Two offline devices could otherwise mint the same id and collide.
    const r = await api.post('/api/items/expenses', { ...expense('Forged'), id: 'client-chosen-id' });
    assert.equal(r.status, 200);
    assert.notEqual(r.json.item.id, 'client-chosen-id');
  });

  test('ids are unique across entries', async () => {
    const ids = (await listExpenses()).map(e => e.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  test('patches only the addressed entry', async () => {
    const before = await listExpenses();
    const target = before[0];
    const r = await api.patch('/api/items/expenses/' + target.id, { amount: 99.5, desc: 'Coffee (fixed)' });
    assert.equal(r.status, 200);
    assert.equal(r.json.item.amount, 99.5);
    assert.equal(r.json.item.id, target.id, 'id must not change');

    const after = await listExpenses();
    assert.equal(after.length, before.length);
    assert.equal(after.filter(e => e.desc === 'Coffee (fixed)').length, 1);
  });

  test('a concurrent create survives another device deleting its own row', async () => {
    // This is the bug the endpoints exist to fix.
    const deviceA = client(srv.base);
    await deviceA.post('/api/login', { username: 'dave', password: 'davepass1' });
    const mine = (await deviceA.post('/api/items/expenses', expense('Device A row'))).json.item;

    const deviceB = client(srv.base);
    await deviceB.post('/api/login', { username: 'dave', password: 'davepass1' });
    await deviceB.post('/api/items/expenses', expense('Device B row'));

    await deviceA.del('/api/items/expenses/' + mine.id);

    const descs = (await listExpenses()).map(e => e.desc);
    assert.ok(descs.includes('Device B row'), "the other device's row was lost");
    assert.ok(!descs.includes('Device A row'), 'our own row should be gone');
  });

  test('delete is idempotent', async () => {
    const created = (await api.post('/api/items/expenses', expense('Twice'))).json.item;
    assert.equal((await api.del('/api/items/expenses/' + created.id)).status, 200);
    assert.equal((await api.del('/api/items/expenses/' + created.id)).status, 200);
  });

  test('patching a missing entry is a 404', async () => {
    assert.equal((await api.patch('/api/items/expenses/nope', { amount: 1 })).status, 404);
  });

  test('unknown collection is a 404', async () => {
    assert.equal((await api.post('/api/items/bogus', {})).status, 404);
  });

  test('rejects a non-object body', async () => {
    assert.equal((await api.post('/api/items/expenses', [1, 2, 3])).status, 400);
  });

  test('one account cannot see or touch another account\'s rows', async () => {
    const mallory = client(srv.base);
    await mallory.post('/api/register', { username: 'mallory', password: 'mallorypass1' });
    assert.deepEqual((await mallory.get('/api/data')).json[EXP] || [], []);

    const victim = (await listExpenses())[0];
    const r = await mallory.patch('/api/items/expenses/' + victim.id, { amount: 1 });
    assert.equal(r.status, 404, 'should not be able to patch across accounts');

    const still = await listExpenses();
    assert.ok(still.some(e => e.id === victim.id), "victim's row disappeared");
  });
});

describe('whole-blob /api/data allowlist', () => {
  let srv, api;
  before(async () => {
    srv = await startServer();
    api = client(srv.base);
    await api.post('/api/register', { username: 'erin', password: 'erinpass1' });
  });
  after(async () => { await srv.stop(); });

  test('accepts the known array keys', async () => {
    for (const key of ['cowork_expenses_v1', 'cowork_income_v1', 'cowork_wishlist_v1', 'cowork_categories_v1']) {
      assert.equal((await api.post('/api/data', { key, value: [] })).status, 200, key);
    }
  });

  test('accepts preferences as an object', async () => {
    const r = await api.post('/api/data', { key: 'cowork_prefs_v1', value: { currency: 'GHS' } });
    assert.equal(r.status, 200);
  });

  test('rejects the wrong shape for a key', async () => {
    assert.equal((await api.post('/api/data', { key: 'cowork_prefs_v1', value: [] })).status, 400);
    assert.equal((await api.post('/api/data', { key: 'cowork_expenses_v1', value: {} })).status, 400);
  });

  test('rejects an unknown key', async () => {
    assert.equal((await api.post('/api/data', { key: 'anything_else', value: [] })).status, 400);
  });

  test('round-trips what it stored', async () => {
    await api.post('/api/data', { key: 'cowork_categories_v1', value: [{ name: 'Gym', color: '#968ae0' }] });
    await flushed();
    const back = (await api.get('/api/data')).json['cowork_categories_v1'];
    assert.deepEqual(back, [{ name: 'Gym', color: '#968ae0' }]);
  });
});
