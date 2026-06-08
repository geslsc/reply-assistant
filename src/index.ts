import { loadEnv, getEnv } from './config/env';
import { logger } from './config/logger';
import { bootstrapApp } from './bootstrap';
import { checkDbConnection, closePool } from './db/client';
import { getRepositoryInitMode } from './repositories';
import { handleLineWebhook } from './routes/lineWebhook';
import { isKnowledgeBaseEmpty } from './services/knowledgeBaseService';

loadEnv();

import express, { Request, Response } from 'express';

const app = express();

app.get('/health', async (_req: Request, res: Response) => {
  const mode = getRepositoryInitMode();
  let knowledgeEmpty: boolean | undefined;

  try {
    if (mode) {
      knowledgeEmpty = await isKnowledgeBaseEmpty();
    }
  } catch {
    knowledgeEmpty = undefined;
  }

  if (mode === 'postgres') {
    const connected = await checkDbConnection();
    if (!connected) {
      res.status(503).json({
        ok: false,
        service: 'reply-assistant',
        db: 'disconnected',
      });
      return;
    }
    res.json({
      ok: true,
      service: 'reply-assistant',
      db: 'connected',
      ...(knowledgeEmpty === true ? { knowledge_empty: true } : {}),
    });
    return;
  }

  res.json({
    ok: true,
    service: 'reply-assistant',
    db: mode ?? 'memory',
    ...(knowledgeEmpty === true ? { knowledge_empty: true } : {}),
  });
});

app.post('/webhook/line', express.raw({ type: '*/*' }), (req, res) => {
  void handleLineWebhook(req, res);
});

const PORT = getEnv().PORT;

async function start(): Promise<void> {
  try {
    await bootstrapApp();
    app.listen(PORT, () => {
      logger.info('Reply assistant listening', { port: PORT });
    });
  } catch (error) {
    logger.error('Failed to start application', {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }
}

if (require.main === module) {
  void start();
}

process.on('SIGTERM', () => {
  void closePool();
});

export default app;
export { start };
