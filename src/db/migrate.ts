import { loadEnv } from '../config/env';
import { logger } from '../config/logger';
import { closePool, runMigrations } from './client';
import { initRepositories } from '../repositories';

async function main(): Promise<void> {
  loadEnv();
  await initRepositories('postgres');
  await runMigrations();
  logger.info('Database migration completed');
  await closePool();
}

main().catch((error) => {
  logger.error('Migration failed', {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
