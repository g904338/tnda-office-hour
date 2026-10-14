import { expect, test } from 'vitest';
import sodium from 'libsodium-wrappers';
import { base64ToUtf8, bytesToBase64, encryptSecret, utf8ToBase64 } from '../../src/cue/data/crypto';

test('UTF-8 base64 round trip, large input included', () => {
  const s = '中文 ✅ emoji 🎬 ' + 'x'.repeat(200_000);
  expect(base64ToUtf8(utf8ToBase64(s))).toBe(s);
  expect(utf8ToBase64('中')).toBe('5Lit');
});

test('sealed boxes open with libsodium, the way GitHub opens secrets', async () => {
  await sodium.ready;
  const kp = sodium.crypto_box_keypair();
  const url = 'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz_ABCDEFG-123';
  const sealed = encryptSecret(url, bytesToBase64(kp.publicKey));
  const opened = sodium.crypto_box_seal_open(sodium.from_base64(sealed, sodium.base64_variants.ORIGINAL), kp.publicKey, kp.privateKey);
  expect(sodium.to_string(opened)).toBe(url);
  // a fresh ephemeral key every time
  expect(encryptSecret(url, bytesToBase64(kp.publicKey))).not.toBe(sealed);
});
