// MultiDSH shared protocol helpers.
// Plain ESM, no dependencies: usable from the Directory (Node or Worker),
// the Host sidecar, and tests.

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const APP_NAME = 'MultiDSH';
export const PROTOCOL_VERSION = 1;

/** Admin/control prefix served by the host sidecar. */
export const ADMIN_PREFIX = '/__fleet';

/** Default ports. */
export const DEFAULT_DSH_PORT = 3080;
export const DEFAULT_ADMIN_PORT = 4080;

const JOIN_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32

export function nowMs() {
  return Date.now();
}

/** `pool_ab12cd34ef56` style identifiers. */
export function newId(prefix) {
  return `${prefix}_${randomBytes(6).toString('hex')}`;
}

/** Opaque bearer token for devices (returned once, stored hashed). */
export function newDeviceToken() {
  return `mdt_${randomBytes(32).toString('base64url')}`;
}

/** Per-host secret used to sign one-time pairing nonces. */
export function newPairSecret() {
  return `mps_${randomBytes(32).toString('base64url')}`;
}

export function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex');
}

/** Hash a device token for storage / lookup. */
export function hashToken(token) {
  return sha256Hex(String(token));
}

/** Human-typed 8 character pool code. */
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

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

/**
 * Sign a one-time pairing nonce.
 * @param {string} pairSecret per-host secret
 * @param {{hostId: string, clientId: string, exp: number, jti: string}} payload
 */
export function signNonce(pairSecret, payload) {
  const body = b64url(JSON.stringify({ v: PROTOCOL_VERSION, ...payload }));
  const sig = createHmac('sha256', pairSecret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

/**
 * Verify a pairing nonce. Throws on any failure.
 * Replay protection is the caller's job (track consumed `jti`).
 * @returns {{v:number, hostId:string, clientId:string, exp:number, jti:string}}
 */
export function verifyNonce(pairSecret, token, options = {}) {
  const raw = String(token ?? '');
  const dot = raw.lastIndexOf('.');
  if (dot <= 0) throw new Error('malformed nonce');
  const body = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  const expected = createHmac('sha256', pairSecret).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error('bad nonce signature');
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
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

export function isActive(device) {
  return device?.status === 'active';
}

/** Public base URL without a trailing slash. */
export function normalizeBaseUrl(url) {
  return String(url ?? '').trim().replace(/\/+$/, '');
}

export function isLoopbackHost(host) {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}
