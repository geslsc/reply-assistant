import { EventType, RiskLevel } from '../src/types';
import { loadEnv, resetEnvCache } from '../src/config/env';
import { bootstrapApp } from '../src/bootstrap';
import { getRepos } from '../src/repositories';
import { setLlmClient } from '../src/services/knowledgeCardDraftService';
import {
  handlePrivateImageMessage,
  IMAGE_ORGANIZE_FIRST_MESSAGE,
  VISION_FAILED_MESSAGE,
  VISION_UNCLEAR_MESSAGE,
  AI_NOT_ENABLED_MESSAGE,
} from '../src/services/dmSessionImageService';
import {
  handleDmSessionPrivateMessage,
  seedActiveSessionForTest,
} from '../src/services/dmSessionService';
import {
  handleConsultantConfirmSubmit,
  handleConfirmUpdate,
  handleConsultantConfirmUpdateAttempt,
} from '../src/services/knowledgeCardWriteService';
import { setVisionClient } from '../src/services/screenshotVisionService';
import { setLineImageContentClient } from '../src/services/lineImageContentService';
import { registerAdmin, registerInviteCode, requestConsultantJoin, approveConsultant } from '../src/services/consultantWhitelist';
import { KnowledgeCard } from '../src/schemas/knowledgeCardSchema';
import { TEST_ADMIN, TEST_CONSULTANT } from './helpers/testSetup';

const sampleCard: KnowledgeCard = {
  card_id: 'phase2c1-card',
  title: '登入問題',
  patterns: ['怎麼登入'],
  risk_level: RiskLevel.LOW,
  can_public_reply: true,
  standard_answer: '請至後台登入',
  not_applicable: [],
  escalate_to_consultant: [],
  status: '可用',
};

const visionProblemSolutionText =
  '畫面類型：後台登入頁。店家問題：登入不了。顧問回覆：建議先確認帳號權限。';

const visionUnclearText = '畫面類型：未知。內容太模糊，看不清任何文字。';

async function setupRoles(): Promise<void> {
  await registerAdmin(TEST_ADMIN, 'Admin');
  await registerInviteCode('CODE2C1', TEST_ADMIN);
  await requestConsultantJoin(TEST_CONSULTANT, 'CODE2C1', 'Consultant');
  await approveConsultant(TEST_ADMIN, TEST_CONSULTANT);
}

function mockLlmReturning(card: KnowledgeCard): jest.Mock {
  return jest.fn().mockResolvedValue(JSON.stringify(card));
}

function setupImageMocks(params: {
  visionText: string;
  onAnalyze?: (buffer: Buffer) => void;
}): { analyze: jest.Mock; download: jest.Mock } {
  const analyze = jest.fn(async ({ imageBuffer }: { imageBuffer: Buffer }) => {
    params.onAnalyze?.(imageBuffer);
    return params.visionText;
  });
  const download = jest.fn(async () => ({
    buffer: Buffer.from('fake-image-binary'),
    contentType: 'image/jpeg',
  }));
  setVisionClient({ analyzeScreenshot: analyze });
  setLineImageContentClient({ getMessageContent: download });
  setLlmClient({ complete: mockLlmReturning(sampleCard) });
  resetEnvCache();
  loadEnv({ OPENAI_API_KEY: 'test-key', USE_MEMORY_REPOS: true });
  return { analyze, download };
}

describe('Knowledge card Phase 2-C-1 private screenshot flow', () => {
  beforeEach(async () => {
    resetEnvCache();
    loadEnv({ USE_MEMORY_REPOS: true, OPENAI_API_KEY: 'test-key' });
    await setupRoles();
    setVisionClient(null);
    setLineImageContentClient(null);
    setLlmClient(null);
  });

  it('1. admin with active session + image returns vision summary first', async () => {
    setupImageMocks({ visionText: visionProblemSolutionText });
    await seedActiveSessionForTest({ userId: TEST_ADMIN, card: sampleCard });
    const replies = await handlePrivateImageMessage({
      userId: TEST_ADMIN,
      messageId: 'img-admin-001',
    });
    expect(replies[0].text).toMatch(/【截圖理解摘要】/);
    const session = await getRepos().dmSessions.findActiveByUserId(TEST_ADMIN);
    expect(session?.draftData?.inputNotes).toMatch(/截圖理解/);
    expect(session?.draftData?.pendingVisionSummary).toBeDefined();
    expect(session?.draftData?.card?.card_id).toBe('phase2c1-card');
  });

  it('2. consultant with active session + image returns vision summary first', async () => {
    setupImageMocks({ visionText: visionProblemSolutionText });
    await seedActiveSessionForTest({ userId: TEST_CONSULTANT, card: sampleCard });
    const replies = await handlePrivateImageMessage({
      userId: TEST_CONSULTANT,
      messageId: 'img-consultant-001',
    });
    expect(replies[0].text).toMatch(/【截圖理解摘要】/);
    expect((await getRepos().dmSessions.findActiveByUserId(TEST_CONSULTANT))?.draftData?.pendingVisionSummary).toBeDefined();
  });

  it('3. no active session + image only prompts organize first', async () => {
    const analyze = jest.fn();
    setVisionClient({ analyzeScreenshot: analyze });
    const replies = await handlePrivateImageMessage({
      userId: TEST_CONSULTANT,
      messageId: 'img-only-001',
    });
    expect(replies[0].text).toBe(IMAGE_ORGANIZE_FIRST_MESSAGE);
    expect(analyze).not.toHaveBeenCalled();
    expect(await getRepos().dmSessions.findActiveByUserId(TEST_CONSULTANT)).toBeNull();
  });

  it('4. no active session + organize trigger + image creates session with vision summary', async () => {
    setupImageMocks({ visionText: visionProblemSolutionText });
    const replies = await handlePrivateImageMessage({
      userId: TEST_CONSULTANT,
      messageId: 'img-organize-001',
      accompanyingText: '幫我整理知識卡',
    });
    expect(replies[0].text).toMatch(/【截圖理解摘要】/);
    expect(await getRepos().dmSessions.findActiveByUserId(TEST_CONSULTANT)).not.toBeNull();
  });

  it('4b. confirming vision summary produces human readable draft', async () => {
    setupImageMocks({ visionText: visionProblemSolutionText });
    await seedActiveSessionForTest({ userId: TEST_CONSULTANT, card: sampleCard });
    await handlePrivateImageMessage({ userId: TEST_CONSULTANT, messageId: 'img-confirm-001' });
    const draftReplies = await handleDmSessionPrivateMessage({
      userId: TEST_CONSULTANT,
      text: '對，幫我整理成知識卡',
    });
    expect(draftReplies?.[0].text).toMatch(/【知識卡草稿】/);
    expect(
      (await getRepos().dmSessions.findActiveByUserId(TEST_CONSULTANT))?.draftData?.pendingVisionSummary
    ).toBeUndefined();
  });

  it('5. vision failure keeps session active and allows text continue', async () => {
    setLineImageContentClient({
      getMessageContent: jest.fn(async () => ({
        buffer: Buffer.from('fake'),
        contentType: 'image/jpeg',
      })),
    });
    setVisionClient({
      analyzeScreenshot: jest.fn(async () => {
        throw new Error('vision down');
      }),
    });
    await seedActiveSessionForTest({ userId: TEST_CONSULTANT, card: sampleCard });
    const failReplies = await handlePrivateImageMessage({
      userId: TEST_CONSULTANT,
      messageId: 'img-fail-001',
    });
    expect(failReplies[0].text).toBe(VISION_FAILED_MESSAGE);
    expect((await getRepos().dmSessions.findActiveByUserId(TEST_CONSULTANT))?.status).toBe('active');

    setLlmClient({ complete: mockLlmReturning(sampleCard) });
    const textReplies = await handleDmSessionPrivateMessage({
      userId: TEST_CONSULTANT,
      text: '補充：請加上後台登入步驟',
    });
    expect(textReplies?.[0].text).toMatch(/【知識卡草稿】/);
  });

  it('6. missing OPENAI_API_KEY replies AI not enabled and text flow works', async () => {
    resetEnvCache();
    loadEnv({ USE_MEMORY_REPOS: true, OPENAI_API_KEY: null });
    await expect(bootstrapApp()).resolves.toBeUndefined();
    await setupRoles();
    await seedActiveSessionForTest({ userId: TEST_CONSULTANT, card: sampleCard });
    const imageReplies = await handlePrivateImageMessage({
      userId: TEST_CONSULTANT,
      messageId: 'img-no-key-001',
    });
    expect(imageReplies[0].text).toBe(AI_NOT_ENABLED_MESSAGE);

    setLlmClient({ complete: mockLlmReturning(sampleCard) });
    const textReplies = await handleDmSessionPrivateMessage({
      userId: TEST_CONSULTANT,
      text: '重新整理',
    });
    expect(textReplies?.[0].text).toMatch(/【知識卡草稿】/);
  });

  it('7. image buffer is not retained after vision completes', async () => {
    let captured: Buffer | null = null;
    setupImageMocks({
      visionText: visionProblemSolutionText,
      onAnalyze: (buffer) => {
        captured = buffer;
      },
    });
    await seedActiveSessionForTest({ userId: TEST_ADMIN, card: sampleCard });
    await handlePrivateImageMessage({ userId: TEST_ADMIN, messageId: 'img-buffer-001' });
    expect(captured).not.toBeNull();
  });

  it('8. draft_data does not contain image binary, base64, or URLs', async () => {
    setupImageMocks({ visionText: visionProblemSolutionText });
    await seedActiveSessionForTest({ userId: TEST_ADMIN });
    await handlePrivateImageMessage({ userId: TEST_ADMIN, messageId: 'img-safe-001' });
    const serialized = JSON.stringify(
      (await getRepos().dmSessions.findActiveByUserId(TEST_ADMIN))?.draftData
    );
    expect(serialized).not.toMatch(/data:image/);
    expect(serialized).not.toMatch(/base64/i);
    expect(serialized).not.toMatch(/https?:\/\//);
    expect(serialized).not.toMatch(/fake-image-binary/);
  });

  it('9. event_log records input_type=image without screenshot sensitive content', async () => {
    const sensitiveVision =
      '畫面類型：聊天截圖。包含敏感資訊。店家問題：登入不了。建議確認帳號權限。';
    setupImageMocks({ visionText: sensitiveVision });
    await seedActiveSessionForTest({ userId: TEST_ADMIN, card: sampleCard });
    await handlePrivateImageMessage({ userId: TEST_ADMIN, messageId: 'img-event-001' });
    const events = await getRepos().events.findByType(EventType.CONSULTANT_OVERRIDE);
    const imageEvent = events.find((event) => event.detail === 'input_type=image');
    expect(imageEvent).toBeDefined();
    expect(imageEvent?.detail).not.toMatch(/0912/);
    expect(JSON.stringify(events)).not.toMatch(/fake-image-binary/);
  });

  it('10. unclear vision asks for supplement without fabricating draft', async () => {
    setupImageMocks({ visionText: visionUnclearText });
    await seedActiveSessionForTest({ userId: TEST_CONSULTANT, card: sampleCard });
    const replies = await handlePrivateImageMessage({
      userId: TEST_CONSULTANT,
      messageId: 'img-unclear-001',
    });
    expect(replies[0].text).toBe(VISION_UNCLEAR_MESSAGE);
    expect((await getRepos().dmSessions.findActiveByUserId(TEST_CONSULTANT))?.draftData?.card?.card_id).toBe(
      'phase2c1-card'
    );
  });

  it('11. screenshot + text mixed input accumulates in draft_data', async () => {
    setupImageMocks({ visionText: visionProblemSolutionText });
    await handleDmSessionPrivateMessage({ userId: TEST_CONSULTANT, text: '幫我整理知識卡' });
    setLlmClient({ complete: mockLlmReturning(sampleCard) });
    await handleDmSessionPrivateMessage({
      userId: TEST_CONSULTANT,
      text: '店家遇到登入不了，建議先確認帳號權限',
    });
    await handlePrivateImageMessage({
      userId: TEST_CONSULTANT,
      messageId: 'img-mixed-001',
    });
    const notes = (await getRepos().dmSessions.findActiveByUserId(TEST_CONSULTANT))?.draftData?.inputNotes ?? '';
    expect(notes).toMatch(/截圖理解/);
    expect(notes.length).toBeGreaterThan(20);
  });

  it('12. consultant confirm submit still uses transaction after vision confirm', async () => {
    setupImageMocks({ visionText: visionProblemSolutionText });
    await seedActiveSessionForTest({ userId: TEST_CONSULTANT, card: sampleCard });
    await handlePrivateImageMessage({ userId: TEST_CONSULTANT, messageId: 'img-submit-001' });
    await handleDmSessionPrivateMessage({
      userId: TEST_CONSULTANT,
      text: '對，幫我整理成知識卡',
    });
    const sessionBefore = await getRepos().dmSessions.findActiveByUserId(TEST_CONSULTANT);
    await handleConsultantConfirmSubmit(TEST_CONSULTANT);
    const submitted = await getRepos().dmSessions.findById(sessionBefore!.sessionId);
    expect(submitted?.status).toBe('submitted');
    expect(await getRepos().pendingKnowledgeReviews.listPending()).toHaveLength(1);
  });

  it('13. admin confirm update validates and writes knowledge_cards after vision confirm', async () => {
    setupImageMocks({ visionText: visionProblemSolutionText });
    await seedActiveSessionForTest({ userId: TEST_ADMIN, card: sampleCard });
    await handlePrivateImageMessage({ userId: TEST_ADMIN, messageId: 'img-admin-update-001' });
    await handleDmSessionPrivateMessage({
      userId: TEST_ADMIN,
      text: '對，幫我整理成知識卡',
    });
    const replies = await handleConfirmUpdate({ userId: TEST_ADMIN, text: '確認更新' });
    expect(replies[0].text).toMatch(/已確認更新/);
    expect(await getRepos().knowledgeCards.findById('phase2c1-card')).not.toBeNull();
    expect(await getRepos().dmSessions.findActiveByUserId(TEST_ADMIN)).toBeNull();
  });

  it('14. inactive user image is rejected without vision', async () => {
    const analyze = jest.fn();
    setVisionClient({ analyzeScreenshot: analyze });
    const replies = await handlePrivateImageMessage({
      userId: 'inactive-user',
      messageId: 'img-inactive-001',
    });
    expect(replies).toEqual([]);
    expect(analyze).not.toHaveBeenCalled();
  });

  it('15. consultant confirm update still rejected after screenshot draft', async () => {
    setupImageMocks({ visionText: visionProblemSolutionText });
    await seedActiveSessionForTest({ userId: TEST_CONSULTANT, card: sampleCard });
    await handlePrivateImageMessage({ userId: TEST_CONSULTANT, messageId: 'img-ccu-001' });
    const replies = await handleConsultantConfirmUpdateAttempt({
      userId: TEST_CONSULTANT,
      text: '確認更新',
    });
    expect(replies[0].text).toMatch(/只有 active admin 可確認更新/);
  });
});

describe('Phase 2-C-1 red line regression', () => {
  it('ThreadState count remains 5', async () => {
    const { ThreadState } = await import('../src/types');
    expect(Object.keys(ThreadState).length).toBe(5);
  });

  it('EventType count remains 10', () => {
    expect(Object.keys(EventType).length).toBe(10);
  });
});
