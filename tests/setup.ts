import { resetEnvCache, loadEnv } from '../src/config/env';
import { resetRepositories } from '../src/repositories';
import { initKnowledgeBase } from '../src/services/knowledgeBaseService';
import { setLineMessageClient } from '../src/services/lineMessageService';
import { clearAllPendingConfirmations } from '../src/services/consultantConfirmationService';
import { clearKnowledgeCardWriteState } from '../src/services/knowledgeCardWriteService';
import { clearBulkImportState } from '../src/services/knowledgeCardImportService';
import { clearPrivateFallbackState } from '../src/services/privateFallbackHintService';
import { clearConvergenceTimersForTest } from '../src/services/groupMessageConvergenceService';
import { clearCorrectionRemindersForTest } from '../src/services/consultantCorrectionService';
import { clearHandoffReplyContext } from '../src/services/handoffKnowledgeDraftService';
import { setLineGroupSummaryClient } from '../src/services/lineGroupSummaryService';

beforeEach(async () => {
  resetEnvCache();
  loadEnv({
    NODE_ENV: 'test',
    USE_MEMORY_REPOS: true,
    DEBOUNCE_SECONDS: 0,
    LINE_CHANNEL_SECRET: 'test-channel-secret',
    LINE_CHANNEL_ACCESS_TOKEN: 'test-access-token',
  });
  await resetRepositories('memory');
  clearConvergenceTimersForTest();
  clearAllPendingConfirmations();
  clearKnowledgeCardWriteState();
  clearPrivateFallbackState();
  clearBulkImportState();
  clearCorrectionRemindersForTest();
  clearHandoffReplyContext();
  await initKnowledgeBase();
  setLineMessageClient({
    replyText: jest.fn().mockResolvedValue(undefined),
    pushText: jest.fn().mockImplementation(async (_userId, _text) => `mock-msg-${Date.now()}`),
  });
  setLineGroupSummaryClient(null);
});
