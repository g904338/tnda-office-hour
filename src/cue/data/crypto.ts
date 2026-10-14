// Encoding helpers and libsodium's "sealed box", which GitHub requires for
// repository secrets: the webhook URL is encrypted in this browser with the
// repository's public key, so only GitHub Actions can ever read it again.

import nacl from 'tweetnacl';
import { blake2b } from 'blakejs';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64.replace(/\s+/g, ''));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export const utf8ToBase64 = (text: string) => bytesToBase64(encoder.encode(text));
export const base64ToUtf8 = (b64: string) => decoder.decode(base64ToBytes(b64));

/** crypto_box_seal: an ephemeral key pair, nonce = BLAKE2b(epk ‖ pk), output epk ‖ box. */
export function sealedBox(message: Uint8Array, publicKey: Uint8Array): Uint8Array {
  if (publicKey.length !== nacl.box.publicKeyLength) throw new Error('bad public key');
  const eph = nacl.box.keyPair();
  const nonceInput = new Uint8Array(64);
  nonceInput.set(eph.publicKey, 0);
  nonceInput.set(publicKey, 32);
  const nonce = blake2b(nonceInput, undefined, nacl.box.nonceLength);
  const boxed = nacl.box(message, nonce, publicKey, eph.secretKey);
  const out = new Uint8Array(32 + boxed.length);
  out.set(eph.publicKey, 0);
  out.set(boxed, 32);
  eph.secretKey.fill(0);
  return out;
}

/** Encrypts a secret value the way GitHub's REST API expects it. */
export function encryptSecret(value: string, publicKeyBase64: string): string {
  return bytesToBase64(sealedBox(encoder.encode(value), base64ToBytes(publicKeyBase64)));
}
