import { loadEnv, getEnv } from './config/env';
import { logger } from './config/logger';
import { bootstrapApp } from './bootstrap';
import { checkDbConnection, closePool } from './db/client';
import { getRepositoryInitMode } from './repositories';
import { handleLineWebhook } from './routes/lineWebhook';
import { loadKnowledgeBase } from './services/knowledgeBaseService';

loadEnv();
loadKnowledgeBase();

import express, { Request, Response } from 'express';

const app = express();

app.get('/health', async (_req: Request, res: Response) => {
  const mode = getRepositoryInitMode();
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
    res.json({ ok: true, service: 'reply-assistant', db: 'connected' });
    return;
  }

  res.json({ ok: true, service: 'reply-assistant', db: mode ?? 'memory' });
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
