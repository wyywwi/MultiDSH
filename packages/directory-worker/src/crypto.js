// WebCrypto helpers for the Cloudflare Worker directory.
//
// Deliberately duplicated from packages/protocol/index.js (which is Node-only:
// node:crypto + Buffer) so the Worker bundle has no Node built-ins. The wire
// format is identical: HMAC-SHA256 over the base64url body, `.` separator.

export const APP_NAME = 'MultiDSH';
export const PROTOCOL_VERSION = 1;

const JOIN_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const encoder = new TextEncoder();

export function nowMs() {
  return Date.now();
}

export function bytesToBase64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64urlToBytes(value) {
  const padded = String(value).replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function randomBytes(length) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

export function newId(prefix) {
  return `${prefix}_${[...randomBytes(6)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export function newDeviceToken() {
  return `mdt_${bytesToBase64url(randomBytes(32))}`;
}

export function newPairSecret() {
  return `mps_${bytesToBase64url(randomBytes(32))}`;
}

export async function sha256Hex(input) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(String(input)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function hashToken(token) {
  return sha256Hex(String(token));
}

export function newJoinCode() {
  const bytes = randomBytes(8);
  let out = '';
  for (let i = 0; i < 8; i += 1) out += JOIN_ALPHABET[bytes[i] % JOIN_ALPHABET.length];
  return out;
}

export function normalizeJoinCode(input) {
  return String(input ?? '')
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/I/g, '1')
    .replace(/L/g, '1')
    .replace(/O/g, '0')
    .replace(/U/g, 'V');
}

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(String(secret)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

function payloadBody(payload) {
  return `${bytesToBase64url(encoder.encode(JSON.stringify({ v: PROTOCOL_VERSION, ...payload })))}`;
}

/** Sign a one-time pairing nonce (same wire format as packages/protocol). */
export async function signNonce(pairSecret, payload) {
  const body = payloadBody(payload);
  const key = await hmacKey(pairSecret);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  return `${body}.${bytesToBase64url(new Uint8Array(sig))}`;
}

/** Verify a pairing nonce. Throws on any failure. */
export async function verifyNonce(pairSecret, token, options = {}) {
  const raw = String(token ?? '');
  const dot = raw.lastIndexOf('.');
  if (dot <= 0) throw new Error('malformed nonce');
  const body = raw.slice(0, dot);
  const sig = base64urlToBytes(raw.slice(dot + 1));
  const key = await hmacKey(pairSecret);
  const ok = await crypto.subtle.verify('HMAC', key, sig, encoder.encode(body));
  if (!ok) throw new Error('bad nonce signature');
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(base64urlToBytes(body)));
  } catch {
    throw new Error('malformed nonce payload');
  }
  if (payload?.v !== PROTOCOL_VERSION) throw new Error('unsupported nonce version');
  if (!Number.isFinite(payload.exp) || payload.exp < nowMs()) throw new Error('nonce expired');
  if (options.hostId && payload.hostId !== options.hostId) throw new Error('nonce host mismatch');
  return payload;
}

/** Strip secrets before returning a device to any client. */
export function sanitizeDevice(device) {
  if (!device) return null;
  const { tokenHash, pairSecret, ...rest } = device;
  return rest;
}

export function normalizeBaseUrl(url) {
  return String(url ?? '').trim().replace(/\/+$/, '');
}
