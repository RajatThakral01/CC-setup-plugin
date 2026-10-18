import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createDb, type Db } from './client.js';
import { runMigrations } from './migrate.js';

export interface TestDatabase {
  db: Db;
  url: string;
  cleanup(): Promise<void>;
}

/** Base URL for test databases: TEST_DATABASE_URL, else DATABASE_URL, else the compose default. */
function baseUrl(): string {
  return (
    process.env['TEST_DATABASE_URL'] ??
    process.env['DATABASE_URL'] ??
    'postgres://setup:setup@localhost:5433/setup_agent'
  );
}

/**
 * Creates a fresh, migrated database per test file so files can run in parallel,
 * and drops it on cleanup.
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const admin = new URL(baseUrl());
  const name = `test_${randomBytes(6).toString('hex')}`;
  const adminClient = new pg.Client({ connectionString: admin.toString() });
  await adminClient.connect();
  try {
    await adminClient.query(`CREATE DATABASE ${name}`);
  } finally {
    await adminClient.end();
  }
  const url = new URL(admin.toString());
  url.pathname = `/${name}`;
  await runMigrations(url.toString());
  const handle = createDb(url.toString());
  return {
    db: handle.db,
    url: url.toString(),
    async cleanup() {
      await handle.close();
      const c = new pg.Client({ connectionString: admin.toString() });
      await c.connect();
      try {
        await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await c.end();
      }
    },
  };
}
