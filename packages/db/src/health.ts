import pg from 'pg';

export interface DbHealth {
  ok: boolean;
  serverVersion?: string;
  error?: string;
}

/** Connects once and reports the server version. Never includes the connection string. */
export async function checkDatabaseHealth(databaseUrl: string): Promise<DbHealth> {
  const client = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
    const result = await client.query<{ server_version: string }>('SHOW server_version');
    const serverVersion = result.rows[0]?.server_version;
    return serverVersion === undefined ? { ok: true } : { ok: true, serverVersion };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'unknown error' };
  } finally {
    await client.end().catch(() => undefined);
  }
}
