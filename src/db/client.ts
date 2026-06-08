import { Pool, PoolClient } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import { getEnv } from '../config/env';
import { logger } from '../config/logger';

let pool: Pool | null = null;

export function getPool(): Pool {
  const env = getEnv();
  if (!env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not configured');
  }
  if (!pool) {
    pool = new Pool({ connectionString: env.DATABASE_URL });
  }
  return pool;
}

export async function checkDbConnection(): Promise<boolean> {
  try {
    const p = getPool();
    await p.query('SELECT 1');
    return true;
  } catch (error) {
    logger.error('Database connection failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function runMigrations(pool?: Pool): Promise<void> {
  const schemaPath = path.join(__dirname, 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf-8');
  const p = pool ?? getPool();
  await p.query(sql);
  logger.info('Database schema applied');
}

export async function dropAllTables(pool?: Pool): Promise<void> {
  const p = pool ?? getPool();
  await p.query(`
    DROP TABLE IF EXISTS knowledge_overrides CASCADE;
    DROP TABLE IF EXISTS invite_codes CASCADE;
    DROP TABLE IF EXISTS event_logs CASCADE;
    DROP TABLE IF EXISTS issue_threads CASCADE;
    DROP TABLE IF EXISTS consultants CASCADE;
    DROP TABLE IF EXISTS group_flags CASCADE;
  `);
}

export async function resetDatabase(pool?: Pool): Promise<void> {
  await dropAllTables(pool);
  await runMigrations(pool);
}

export function setPoolForTests(testPool: Pool | null): void {
  pool = testPool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
