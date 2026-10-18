import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { generateSigningKeyPair } from './signing.js';

describe('generateSigningKeyPair', () => {
  it('produces a working Ed25519 pair', () => {
    const { privateKeyPem, publicKeyPem } = generateSigningKeyPair();
    expect(privateKeyPem).toContain('BEGIN PRIVATE KEY');
    expect(publicKeyPem).toContain('BEGIN PUBLIC KEY');
    const data = Buffer.from('snapshot');
    const sig = sign(null, data, createPrivateKey(privateKeyPem));
    expect(verify(null, data, createPublicKey(publicKeyPem), sig)).toBe(true);
    expect(verify(null, Buffer.from('snapshoT'), createPublicKey(publicKeyPem), sig)).toBe(false);
  });
});
