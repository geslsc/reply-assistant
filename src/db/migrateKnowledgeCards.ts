import { loadEnv } from '../config/env';
import { logger } from '../config/logger';
import { closePool } from './client';
import { initRepositories } from '../repositories';
import {
  formatMigrationReport,
  migrateKnowledgeCardsFromJson,
} from '../services/knowledgeCardMigrationService';
import { refreshKnowledgeCache } from '../services/knowledgeBaseService';

async function main(): Promise<void> {
  loadEnv();
  const dryRun = process.argv.includes('--dry-run');
  await initRepositories('postgres');
  const result = await migrateKnowledgeCardsFromJson({ dryRun });
  const report = formatMigrationReport(result, dryRun);
  console.log(report);

  if (!dryRun) {
    if (!result.countMatch) {
      logger.error('Knowledge card migration count mismatch', {
        jsonCount: result.jsonCount,
        dbCount: result.dbCount,
      });
      process.exit(1);
    }
    await refreshKnowledgeCache();
  }

  await closePool();
}

main().catch((error) => {
  logger.error('Knowledge card migration failed', {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
