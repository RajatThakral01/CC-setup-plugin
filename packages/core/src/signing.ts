import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from 'node:crypto';

export interface SigningKeyPair {
  privateKeyPem: string;
  publicKeyPem: string;
}

/** Ed25519 key pair for signing catalog snapshots (NFR-5). */
export function generateSigningKeyPair(): SigningKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

/** Detached Ed25519 signature, base64. */
export function signBytes(privateKeyPem: string, data: Uint8Array): string {
  return sign(null, data, createPrivateKey(privateKeyPem)).toString('base64');
}

/** True only for a valid signature of exactly these bytes. Never throws on bad input. */
export function verifyBytes(
  publicKeyPem: string,
  data: Uint8Array,
  signatureBase64: string,
): boolean {
  try {
    return verify(
      null,
      data,
      createPublicKey(publicKeyPem),
      Buffer.from(signatureBase64, 'base64'),
    );
  } catch {
    return false;
  }
}

export function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}
