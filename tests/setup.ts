import { resetEnvCache, loadEnv } from '../src/config/env';
import { resetRepositories } from '../src/repositories';
import { initKnowledgeBase } from '../src/services/knowledgeBaseService';
import { setLineMessageClient } from '../src/services/lineMessageService';
import { clearAllPendingConfirmations } from '../src/services/consultantConfirmationService';
import { clearKnowledgeCardWriteState } from '../src/services/knowledgeCardWriteService';
import { clearBulkImportState } from '../src/services/knowledgeCardImportService';
import { clearPrivateFallbackState } from '../src/services/privateFallbackHintService';
import { setLineGroupSummaryClient } from '../src/services/lineGroupSummaryService';

beforeEach(async () => {
  resetEnvCache();
  loadEnv({
    NODE_ENV: 'test',
    USE_MEMORY_REPOS: true,
    LINE_CHANNEL_SECRET: 'test-channel-secret',
    LINE_CHANNEL_ACCESS_TOKEN: 'test-access-token',
  });
  await resetRepositories('memory');
  clearAllPendingConfirmations();
  clearKnowledgeCardWriteState();
  clearPrivateFallbackState();
  clearBulkImportState();
  await initKnowledgeBase();
  setLineMessageClient({
    replyText: jest.fn().mockResolvedValue(undefined),
    pushText: jest.fn().mockImplementation(async (_userId, _text) => `mock-msg-${Date.now()}`),
  });
  setLineGroupSummaryClient(null);
});
