import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { consumeLocalAuth } from '../public/local-auth.js';

const fixtureToken = 'a'.repeat(64);
function browser(hash, overrides = {}) {
  const events = [];
  return {
    events,
    location: { protocol: 'http:', hostname: '127.0.0.1', pathname: '/', search: '', hash, ...overrides },
    history: { replaceState(_state, _title, url) { events.push(['replace', url]); } },
    localStorage: { setItem(key, value) { events.push(['store', key, value]); } },
  };
}

test('local auth removes the fragment before storing a token', () => {
  const target = browser(`#token=${fixtureToken}`);
  assert.equal(consumeLocalAuth(target), true);
  assert.deepEqual(target.events, [['replace', '/'], ['store', 'comoteApiToken', fixtureToken]]);
});
test('invalid token is removed but never stored', () => {
  const target = browser('#token=invalid');
  assert.equal(consumeLocalAuth(target), false);
  assert.deepEqual(target.events, [['replace', '/']]);
});
test('unrelated fragments are preserved', () => {
  const target = browser('#settings');
  assert.equal(consumeLocalAuth(target), false);
  assert.deepEqual(target.events, []);
});
test('never imports token fragments on non-loopback hosts', () => {
  const target = browser(`#token=${fixtureToken}`, { hostname: 'example.invalid' });
  assert.equal(consumeLocalAuth(target), false);
  assert.deepEqual(target.events, []);
});
test('storage failure still clears the token from the address bar', () => {
  const target = browser(`#token=${fixtureToken}`);
  target.localStorage.setItem = () => { throw new Error('storage disabled'); };
  assert.throws(() => consumeLocalAuth(target), /storage disabled/);
  assert.deepEqual(target.events, [['replace', '/']]);
});
test('HTML loads authentication first and its module bootstraps the browser', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const authIndex = html.indexOf('<script type="module" src="/local-auth.js"></script>');
  assert.ok(authIndex >= 0 && authIndex < html.indexOf('<script type="module" src="/app.js"></script>'));
  const target = browser(`#token=${fixtureToken}`);
  const previous = globalThis.window;
  globalThis.window = target;
  try { await import('../public/local-auth.js?bootstrap-test'); }
  finally {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  }
  assert.deepEqual(target.events, [['replace', '/'], ['store', 'comoteApiToken', fixtureToken]]);
});
