import { loadKnowledgeBase } from '../../src/services/knowledgeBaseService';
import { resetRepositories } from '../../src/repositories';

export async function resetTestState(): Promise<void> {
  await resetRepositories('memory');
  loadKnowledgeBase();
}

export const TEST_GROUP = 'group-test-001';
export const TEST_GROUP_B = 'group-test-002';
export const TEST_CONSULTANT = 'consultant-001';
export const TEST_ADMIN = 'admin-001';
export const TEST_CUSTOMER = 'customer-001';

export function setupTestConsultants(): void {
  // use async helpers in tests directly
}
