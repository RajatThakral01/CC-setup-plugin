import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger, parseConfig } from '@cc-setup-agent/core';
import { createTestDatabase, type TestDatabase } from '@cc-setup-agent/db/testing';
import type { PipelineContext } from './context.js';
import { DISCOVERY_QUEUE, GATES_QUEUE, startWorker } from './worker.js';

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase();
});
afterAll(async () => {
  await t?.cleanup();
});

describe('startWorker', () => {
  it('registers the daily discovery schedule in UTC', async () => {
    const config = parseConfig({ DATABASE_URL: t.url });
    const ctx = {
      config,
      logger: createLogger({ level: 'silent' }),
      db: t.db,
    } as unknown as PipelineContext;
    const stop = await startWorker(ctx);
    const boss = new PgBoss(t.url);
    await boss.start();
    try {
      const gates = await boss.getSchedules(GATES_QUEUE);
      expect(gates).toEqual([
        expect.objectContaining({
          cron: '0 4 * * *',
          options: expect.objectContaining({ tz: 'UTC' }),
        }),
      ]);
      const schedules = await boss.getSchedules(DISCOVERY_QUEUE);
      expect(schedules).toEqual([
        expect.objectContaining({
          name: DISCOVERY_QUEUE,
          cron: '0 2 * * *',
          options: expect.objectContaining({ tz: 'UTC' }),
        }),
      ]);
    } finally {
      await boss.stop({ graceful: false });
      await stop();
    }
  }, 30_000);
});
