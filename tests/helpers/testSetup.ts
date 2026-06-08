import { initKnowledgeBase } from '../../src/services/knowledgeBaseService';
import { resetRepositories } from '../../src/repositories';
import { clearAllPendingConfirmations } from '../../src/services/consultantConfirmationService';
import { setLlmClient } from '../../src/services/knowledgeCardDraftService';
import { setVisionClient } from '../../src/services/screenshotVisionService';
import { setLineImageContentClient } from '../../src/services/lineImageContentService';
import { clearKnowledgeCardWriteState } from '../../src/services/knowledgeCardWriteService';
import { clearBulkImportState } from '../../src/services/knowledgeCardImportService';

export async function resetTestState(): Promise<void> {
  await resetRepositories('memory');
  clearAllPendingConfirmations();
  clearKnowledgeCardWriteState();
  clearBulkImportState();
  setLlmClient(null);
  setVisionClient(null);
  setLineImageContentClient(null);
  await initKnowledgeBase();
}

export const TEST_GROUP = 'group-test-001';
export const TEST_GROUP_B = 'group-test-002';
export const TEST_CONSULTANT = 'consultant-001';
export const TEST_ADMIN = 'admin-001';
export const TEST_CUSTOMER = 'customer-001';

export function setupTestConsultants(): void {
  // use async helpers in tests directly
}
