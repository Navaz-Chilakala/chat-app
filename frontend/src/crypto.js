// End-to-end encryption, done entirely in the browser with the Web Crypto API.
//
// A room is identified by a secret (random, or a passphrase) that only travels in
// the URL fragment (#...), which browsers never send to any server. From it we
// derive, with PBKDF2:
//   - an AES-GCM key used to encrypt every message (including the username), and
//   - an opaque room id (a hash) that the server uses to group messages.
// The server can't get from the room id back to the key, so it only ever sees ciphertext.

const enc = new TextEncoder();
const dec = new TextDecoder();
const SALT = enc.encode('ephemeral-chat/v1');
const ITERATIONS = 250_000;
export const MIN_PASSPHRASE_LENGTH = 8;

function toBase64(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromBase64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toHex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function randomHex(bytes) {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** A new random room secret, safe to put in a URL fragment. */
export function newRoomSecret() {
  return toBase64(crypto.getRandomValues(new Uint8Array(18)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

/** Accept a full invite link, "#secret", or a bare secret/passphrase. */
export function parseRoomInput(input) {
  const trimmed = input.trim();
  const hash = trimmed.indexOf('#');
  return hash >= 0 ? decodeURIComponent(trimmed.slice(hash + 1)) : trimmed;
}

export async function deriveRoom(secret) {
  const base = await crypto.subtle.importKey('raw', enc.encode(secret), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: SALT, iterations: ITERATIONS, hash: 'SHA-256' }, base, 512),
  );
  const key = await crypto.subtle.importKey('raw', bits.slice(0, 32), 'AES-GCM', false, ['encrypt', 'decrypt']);
  const roomId = toHex(await crypto.subtle.digest('SHA-256', bits.slice(32)));
  bits.fill(0);
  return { key, roomId };
}

export async function encryptMessage(key, payload) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(payload))));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return toBase64(out);
}

/** Returns the decrypted payload, or null if it can't be decrypted (wrong key / tampered). */
export async function decryptMessage(key, data) {
  try {
    const bytes = fromBase64(data);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, key, bytes.slice(12));
    return JSON.parse(dec.decode(plain));
  } catch {
    return null;
  }
}
