import { generateKeyPairSync } from 'node:crypto';

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
