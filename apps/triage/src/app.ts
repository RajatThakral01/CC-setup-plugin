import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import type { Logger } from '@cc-setup-agent/core';
import { AppError } from '@cc-setup-agent/core';
import {
  InvalidTransitionError,
  ItemNotFoundError,
  transitionStatus,
  type Db,
} from '@cc-setup-agent/db';
import { CATEGORIES, statusSchema } from '@cc-setup-agent/shared';
import {
  csrfToken,
  MIN_TOKEN_LENGTH,
  REVIEWER_NAME,
  safeEqual,
  SESSION_COOKIE,
  signSession,
  verifySession,
} from './auth.js';
import {
  countByScope,
  getItemDetail,
  listChanges,
  listQueue,
  setOutOfScope,
  type QueueFilter,
} from './queries.js';
import { changesPage, itemPage, loginPage, queuePage } from './views.js';

export interface TriageDeps {
  db: Db;
  adminToken: string;
  logger: Logger;
  /** Set the Secure cookie flag (when served over HTTPS). */
  secureCookies?: boolean;
}

type Env = { Variables: { reviewer: string; csrf: string } };

const queueQuerySchema = z.object({
  status: z.union([statusSchema, z.literal('all')]).catch('candidate'),
  scope: z.enum(['in', 'out', 'all']).catch('in'),
  category: z.enum(CATEGORIES).optional().catch(undefined),
  q: z.string().max(100).optional().catch(undefined),
});

const statusFormSchema = z.object({
  to: statusSchema,
  reason: z.string().trim().min(3, 'a reason is required').max(2000),
  override: z.string().max(2000).optional(),
});

export class TriageConfigError extends AppError {}

/** Triage server (plan M5). Every route except sign-in requires a signed session. */
export function createApp(deps: TriageDeps): Hono<Env> {
  if (deps.adminToken.length < MIN_TOKEN_LENGTH) {
    throw new TriageConfigError(
      `TRIAGE_ADMIN_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters`,
    );
  }
  const app = new Hono<Env>();

  app.use('*', async (c, next) => {
    c.header('X-Frame-Options', 'DENY');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    c.header(
      'Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
    );
    await next();
  });

  app.get('/login', (c) => c.html(loginPage()));
  app.post('/login', async (c) => {
    const form = await c.req.parseBody();
    const name = typeof form['name'] === 'string' ? form['name'].trim() : '';
    const token = typeof form['token'] === 'string' ? form['token'] : '';
    if (!REVIEWER_NAME.test(name))
      return c.html(loginPage('Name may use letters, digits and . _ @ - (max 64).'), 400);
    if (!safeEqual(token, deps.adminToken)) {
      deps.logger.warn({ name }, 'triage sign-in failed');
      return c.html(loginPage('Wrong token.'), 401);
    }
    setCookie(c, SESSION_COOKIE, signSession(deps.adminToken, name), {
      httpOnly: true,
      sameSite: 'Strict',
      secure: deps.secureCookies ?? false,
      path: '/',
      maxAge: 12 * 3600,
    });
    return c.redirect('/', 303);
  });

  // Everything below needs a valid session; state-changing requests also need the CSRF token.
  app.use('*', async (c, next) => {
    const reviewer = verifySession(deps.adminToken, getCookie(c, SESSION_COOKIE));
    if (!reviewer)
      return c.req.method === 'GET' ? c.redirect('/login', 303) : c.text('Unauthorized', 401);
    const csrf = csrfToken(deps.adminToken, reviewer);
    if (c.req.method !== 'GET') {
      const form = await c.req.parseBody();
      if (typeof form['csrf'] !== 'string' || !safeEqual(form['csrf'], csrf))
        return c.text('Invalid form token', 403);
    }
    c.set('reviewer', reviewer);
    c.set('csrf', csrf);
    await next();
  });

  app.post('/logout', (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.redirect('/login', 303);
  });

  app.get('/', async (c) => {
    const parsed = queueQuerySchema.parse(c.req.query());
    const filter: QueueFilter = {
      status: parsed.status,
      scope: parsed.scope,
      ...(parsed.category ? { category: parsed.category } : {}),
      ...(parsed.q ? { q: parsed.q } : {}),
    };
    const [entries, counts] = await Promise.all([
      listQueue(deps.db, filter),
      countByScope(deps.db, filter.status),
    ]);
    return c.html(queuePage(entries, filter, counts, c.get('reviewer'), c.get('csrf')));
  });

  const renderItem = async (
    c: Context<Env>,
    id: string,
    status: 200 | 400 | 409,
    message?: { kind: 'notice' | 'error'; text: string },
  ) => {
    const detail = await getItemDetail(deps.db, id);
    if (!detail) return c.text('Not found', 404);
    return c.html(itemPage(detail, c.get('reviewer'), c.get('csrf'), message), status);
  };

  app.get('/items/:id', (c) => {
    const saved = c.req.query('saved');
    return renderItem(
      c,
      c.req.param('id'),
      200,
      saved ? { kind: 'notice', text: `Status changed to ${saved}.` } : undefined,
    );
  });

  app.post('/items/:id/status', async (c) => {
    const id = c.req.param('id');
    const parsed = statusFormSchema.safeParse(await c.req.parseBody());
    if (!parsed.success)
      return renderItem(c, id, 400, {
        kind: 'error',
        text: parsed.error.issues.map((i) => i.message).join('; '),
      });
    const { to, reason, override } = parsed.data;
    try {
      await transitionStatus(
        deps.db,
        id,
        to,
        `human:${c.get('reviewer')}`,
        reason,
        override?.trim() ? { overrideNote: override } : {},
      );
    } catch (error) {
      if (error instanceof ItemNotFoundError) return c.text('Not found', 404);
      if (error instanceof InvalidTransitionError)
        return renderItem(c, id, 409, { kind: 'error', text: error.message });
      throw error;
    }
    deps.logger.info({ id, to, reviewer: c.get('reviewer') }, 'status changed in triage');
    return c.redirect(`/items/${encodeURIComponent(id)}?saved=${encodeURIComponent(to)}`, 303);
  });

  app.post('/items/:id/scope', async (c) => {
    const id = c.req.param('id');
    const form = await c.req.parseBody();
    await setOutOfScope(deps.db, id, form['out'] === '1');
    return c.redirect(`/items/${encodeURIComponent(id)}`, 303);
  });

  app.get('/changes', async (c) => {
    const flag = z
      .enum(['plugins', 'mcp', 'settings', 'hooks', 'skills', 'models'])
      .optional()
      .catch(undefined)
      .parse(c.req.query('flag'));
    return c.html(
      changesPage(await listChanges(deps.db, flag), flag, c.get('reviewer'), c.get('csrf')),
    );
  });

  app.onError((error, c) => {
    deps.logger.error({ err: error, path: c.req.path }, 'triage request failed');
    return c.text('Internal error', 500);
  });
  return app;
}
