import { loadEnv, resetEnvCache } from '../src/config/env';
import { bootstrapApp } from '../src/bootstrap';
import { initRepositories } from '../src/repositories';
import {
  formatDraftReply,
  generateKnowledgeCardDraft,
  getLlmClient,
  setLlmClient,
} from '../src/services/knowledgeCardDraftService';
import { handleDmSessionPrivateMessage } from '../src/services/dmSessionService';
import { handleConsultantNaturalLanguage } from '../src/services/consultantActionService';
import { executeReplyToGroup } from '../src/services/replyToGroupService';
import { summarizeCustomerQuestionForConsultant } from '../src/services/consultantPrivateAiService';
import { isAiDraftEnabled } from '../src/services/openaiClient';
import { routeQuestion } from '../src/services/riskRouter';
import {
  registerAdmin,
  approveConsultant,
  registerInviteCode,
  requestConsultantJoin,
} from '../src/services/consultantWhitelist';
import { createPendingHandoff } from '../src/services/pendingHandoffService';
import { createIssueThread } from '../src/services/issueThreadService';
import { deriveShortCode } from '../src/services/shortCodeService';
import { handleServiceIntroduction } from '../src/services/servicePeriodService';
import {
  resetTestState,
  TEST_ADMIN,
  TEST_CONSULTANT,
  TEST_CUSTOMER,
  TEST_GROUP,
} from './helpers/testSetup';

describe('AI API Conservative Integration', () => {
  beforeEach(async () => {
    resetEnvCache();
    await resetTestState();
    setLlmClient(null);
  });

  it('allows production bootstrap without OPENAI_API_KEY', async () => {
    loadEnv({ NODE_ENV: 'production', OPENAI_API_KEY: null, USE_MEMORY_REPOS: true });
    await expect(bootstrapApp()).resolves.toBeUndefined();
    expect(isAiDraftEnabled()).toBe(false);
  });

  it('returns disabled message when consultant requests draft without API key', async () => {
    const result = await generateKnowledgeCardDraft({
      operation: 'create',
      consultantRequest: '整理知識卡：店家遇到登入不了',
    });
    const text = formatDraftReply(result);
    expect(text).toContain('AI 草稿整理尚未啟用');
  });

  it('returns disabled message for summarize without API key', async () => {
    const text = await summarizeCustomerQuestionForConsultant({
      consultantRequest: '摘要店家問題',
      customerQuestion: '登入不了',
    });
    expect(text).toBe('AI 草稿整理尚未啟用');
  });

  it('produces draft with mock LLM in consultant private flow', async () => {
    const complete = jest.fn(async () =>
      JSON.stringify({
        card_id: 'op-test',
        title: '測試',
        patterns: ['測試問題'],
        risk_level: 'low',
        can_public_reply: true,
        standard_answer: '測試回答',
        not_applicable: [],
        escalate_to_consultant: [],
        status: '可用',
      })
    );
    setLlmClient({ complete });

    await registerAdmin(TEST_ADMIN);
    const replies = await handleDmSessionPrivateMessage({
      userId: TEST_ADMIN,
      text: '整理知識卡：店家遇到登入問題',
    });
    expect(complete).toHaveBeenCalled();
    expect(replies?.[0].text).toContain('【知識卡草稿｜');
  });

  it('does not call LLM in group public answer flow', async () => {
    const complete = jest.fn(async () => 'should not run');
    setLlmClient({ complete });
    await handleServiceIntroduction(TEST_GROUP, TEST_ADMIN);
    await routeQuestion('怎麼登入後台');
    expect(complete).not.toHaveBeenCalled();
  });

  it('does not call LLM in REPLY_TO_GROUP flow', async () => {
    const complete = jest.fn(async () => 'should not run');
    setLlmClient({ complete });
    await registerAdmin(TEST_ADMIN);
    await registerInviteCode('CODE', TEST_ADMIN);
    await requestConsultantJoin(TEST_CONSULTANT, 'CODE');
    await approveConsultant(TEST_ADMIN, TEST_CONSULTANT);
    await handleServiceIntroduction(TEST_GROUP, TEST_CONSULTANT);
    const thread = await createIssueThread(TEST_GROUP, 'Q');
    const shortCode = deriveShortCode(thread.issueThreadId, thread.createdAt);
    await createPendingHandoff({
      consultantId: TEST_CONSULTANT,
      issueThreadId: thread.issueThreadId,
      groupId: TEST_GROUP,
      shortCode,
      customerQuestion: 'Q',
    });
    await executeReplyToGroup({
      consultantId: TEST_CONSULTANT,
      replyText: '逐字',
      shortCode,
    });
    expect(complete).not.toHaveBeenCalled();
    expect(getLlmClient()).not.toBeNull();
  });

  it('blocks validator on extra fields and sensitive low risk from mock LLM', async () => {
    setLlmClient({
      async complete() {
        return JSON.stringify({
          card_id: 'pay',
          title: '金流',
          patterns: ['金流'],
          risk_level: 'low',
          can_public_reply: true,
          standard_answer: 'test',
          not_applicable: [],
          escalate_to_consultant: [],
          status: '可用',
          version: 1,
        });
      },
    });
    const result = await generateKnowledgeCardDraft({
      operation: 'create',
      consultantRequest: '新增金流卡',
    });
    expect(result.kind).toBe('single_card');
    if (result.kind === 'single_card') {
      expect(result.validation.valid).toBe(false);
      expect(result.draftJson).toBeNull();
    }
  });

  it('rejects non-consultant private AI request via natural language handler', async () => {
    const complete = jest.fn();
    setLlmClient({ complete });
    const replies = await handleConsultantNaturalLanguage({
      userId: TEST_CUSTOMER,
      text: '整理知識卡',
      isGroup: false,
    });
    expect(replies).toBeNull();
    expect(complete).not.toHaveBeenCalled();
  });
});
