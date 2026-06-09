import { getEnv } from './config/env';
import { logger } from './config/logger';
import { getRepos, initRepositories } from './repositories';
import { initConsultantDraftAi } from './services/openaiClient';
import { initScreenshotVisionClient } from './services/screenshotVisionService';
import { initKnowledgeBase } from './services/knowledgeBaseService';
import { setAsyncConvergenceReplyDeliverer } from './services/groupMessageConvergenceService';
import { deliverDeferredGroupReplies } from './services/lineMessageService';

export async function bootstrapAdmins(): Promise<void> {
  const env = getEnv();
  const repos = getRepos();

  for (const adminId of env.ADMIN_LINE_USER_IDS) {
    await repos.consultants.upsertAdmin(adminId);
    logger.info('Admin upserted from env', { adminId });
  }

  if (env.CONSULTANT_INVITE_CODE && env.ADMIN_LINE_USER_IDS[0]) {
    await repos.consultants.registerInviteCode(
      env.CONSULTANT_INVITE_CODE,
      env.ADMIN_LINE_USER_IDS[0]
    );
  }
}

export async function bootstrapApp(): Promise<void> {
  await initRepositories();
  const initResult = await initKnowledgeBase();
  if (initResult.knowledgeEmpty) {
    logger.warn('knowledge_cards is empty; deploy migration required');
  }
  initConsultantDraftAi();
  initScreenshotVisionClient();
  setAsyncConvergenceReplyDeliverer(async (replies, groupId) => {
    await deliverDeferredGroupReplies(replies, groupId);
  });
  await bootstrapAdmins();
}
