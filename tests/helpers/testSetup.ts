import { loadKnowledgeBase } from '../../src/services/knowledgeBaseService';
import { resetRepositories } from '../../src/repositories';
import { clearAllPendingConfirmations } from '../../src/services/consultantConfirmationService';
import { setLlmClient } from '../../src/services/knowledgeCardDraftService';

export async function resetTestState(): Promise<void> {
  await resetRepositories('memory');
  loadKnowledgeBase();
  clearAllPendingConfirmations();
  setLlmClient(null);
}

export const TEST_GROUP = 'group-test-001';
export const TEST_GROUP_B = 'group-test-002';
export const TEST_CONSULTANT = 'consultant-001';
export const TEST_ADMIN = 'admin-001';
export const TEST_CUSTOMER = 'customer-001';

export function setupTestConsultants(): void {
  // use async helpers in tests directly
}
