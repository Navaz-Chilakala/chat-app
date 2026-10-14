import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decryptMessage, deriveRoom, encryptMessage, newRoomSecret, parseRoomInput } from './crypto.js';

test('same secret gives same room id; different secret does not', async () => {
  const secret = newRoomSecret();
  const a = await deriveRoom(secret);
  const b = await deriveRoom(secret);
  const c = await deriveRoom(newRoomSecret());
  assert.match(a.roomId, /^[0-9a-f]{64}$/);
  assert.equal(a.roomId, b.roomId);
  assert.notEqual(a.roomId, c.roomId);
});

test('messages round-trip and cannot be read with another key', async () => {
  const { key } = await deriveRoom('correct horse battery');
  const { key: other } = await deriveRoom('wrong horse battery');
  const data = await encryptMessage(key, { u: 'ghost', t: 'hi' });
  assert.match(data, /^[A-Za-z0-9+/]+={0,2}$/);
  assert.ok(!data.includes('ghost'));
  assert.deepEqual(await decryptMessage(key, data), { u: 'ghost', t: 'hi' });
  assert.equal(await decryptMessage(other, data), null);
});

test('parseRoomInput accepts links, fragments and bare secrets', () => {
  assert.equal(parseRoomInput('https://x.app/#abc_DEF-1'), 'abc_DEF-1');
  assert.equal(parseRoomInput('  #abc  '), 'abc');
  assert.equal(parseRoomInput('my shared phrase'), 'my shared phrase');
});
