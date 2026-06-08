import { getRepositoryMode } from '../config/env';
import { logger } from '../config/logger';
import { checkDbConnection, runMigrations } from '../db/client';
import { Repositories } from './interfaces';
import { createMemoryRepositories } from './memoryRepositories';
import { createPostgresRepositories } from './postgresRepositories';

let currentRepos: Repositories | null = null;
let initializedMode: 'memory' | 'postgres' | null = null;

export async function initRepositories(mode?: 'memory' | 'postgres'): Promise<Repositories> {
  const effectiveMode = mode ?? getRepositoryMode();

  if (effectiveMode === 'postgres') {
    const connected = await checkDbConnection();
    if (!connected) {
      throw new Error('Failed to connect to PostgreSQL. Check DATABASE_URL.');
    }
    await runMigrations();
    currentRepos = createPostgresRepositories();
  } else {
    currentRepos = createMemoryRepositories();
  }

  initializedMode = effectiveMode;
  logger.info('Repositories initialized', { mode: effectiveMode });
  return currentRepos;
}

export function getRepos(): Repositories {
  if (!currentRepos) {
    throw new Error('Repositories not initialized. Call initRepositories() first.');
  }
  return currentRepos;
}

export function getRepositoryInitMode(): 'memory' | 'postgres' | null {
  return initializedMode;
}

export async function resetRepositories(mode: 'memory' | 'postgres' = 'memory'): Promise<void> {
  await initRepositories(mode);
  const repos = getRepos();
  await repos.groups.clear();
  await repos.threads.clear();
  await repos.events.clear();
  await repos.consultants.clear();
  await repos.knowledgeOverrides.clear();
  await repos.knowledgeCards.clear();
  await repos.pendingHandoffs.clear();
  await repos.pendingKnowledgeReviews.clear();
  await repos.dmSessions.clear();
}
