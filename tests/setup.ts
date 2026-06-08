import { loadEnv, resetEnvCache } from '../src/config/env';
import { resetRepositories } from '../src/repositories';
import { loadKnowledgeBase } from '../src/services/knowledgeBaseService';
import { setLineMessageClient } from '../src/services/lineMessageService';

beforeEach(async () => {
  resetEnvCache();
  loadEnv({
    NODE_ENV: 'test',
    USE_MEMORY_REPOS: true,
    LINE_CHANNEL_SECRET: 'test-channel-secret',
    LINE_CHANNEL_ACCESS_TOKEN: 'test-access-token',
  });
  await resetRepositories('memory');
  loadKnowledgeBase();
  setLineMessageClient({
    replyText: jest.fn().mockResolvedValue(undefined),
    pushText: jest.fn().mockResolvedValue(undefined),
  });
});
