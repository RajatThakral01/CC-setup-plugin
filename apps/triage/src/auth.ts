import { createHmac, timingSafeEqual } from 'node:crypto';

/** Reviewer names become the `human:<name>` actor in the audit log. */
export const REVIEWER_NAME = /^[A-Za-z0-9._@-]{1,64}$/;
export const MIN_TOKEN_LENGTH = 16;
export const SESSION_COOKIE = 'triage_session';

function hmac(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** Session cookie value: `<name>.<hmac(name)>`, signed with the admin token. */
export function signSession(token: string, name: string): string {
  return `${name}.${hmac(token, `session:${name}`)}`;
}

/** Returns the reviewer name for a valid session cookie, else undefined. */
export function verifySession(token: string, cookie: string | undefined): string | undefined {
  if (!cookie) return undefined;
  const dot = cookie.lastIndexOf('.');
  if (dot <= 0) return undefined;
  const name = cookie.slice(0, dot);
  if (!REVIEWER_NAME.test(name)) return undefined;
  return safeEqual(cookie, signSession(token, name)) ? name : undefined;
}

/** Per-session CSRF token for state-changing forms (cookies are also SameSite=Strict). */
export function csrfToken(token: string, name: string): string {
  return hmac(token, `csrf:${name}`);
}
