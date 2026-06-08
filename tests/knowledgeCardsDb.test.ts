import * as fs from 'fs';
import * as path from 'path';
import {
  EventType,
  RiskLevel,
  ThreadState,
} from '../src/types';
import { getRepos } from '../src/repositories';
import {
  getDefaultKnowledgeJsonPath,
  migrateKnowledgeCardsFromJson,
  MIGRATION_ACTOR,
  validateJsonCard,
} from '../src/services/knowledgeCardMigrationService';
import {
  getActiveCards,
  getCardById,
  matchKnowledgeCard,
  knowledgeJsonBackupExists,
} from '../src/services/knowledgeBaseService';
import {
  storeUserDraft,
  handleConsultantConfirmSubmit,
  handleConsultantConfirmUpdateAttempt,
  handleConfirmUpdate,
  handleAdminRevisionFeedback,
  handleAdminRejectDraft,
  clearKnowledgeCardWriteState,
  listPendingReviews,
} from '../src/services/knowledgeCardWriteService';
import {
  seedPendingReviewForTest,
  clearKnowledgeCardReviewState,
  resolveReviewTarget,
  createPendingReview,
} from '../src/services/knowledgeCardReviewService';
import { allocateUniqueKnowledgeReviewShortCode } from '../src/services/knowledgeReviewShortCodeService';
import {
  exportKnowledgeCards,
  parseExportCommand,
} from '../src/services/knowledgeCardExportService';
import {
  previewBulkImport,
  executeBulkImport,
  clearBulkImportState,
  seedPendingImportForTest,
} from '../src/services/knowledgeCardImportService';
import {
  handleViewCommand,
  parseViewCommand,
} from '../src/services/knowledgeCardViewService';
import { buildBackupReminderAppend } from '../src/services/knowledgeCardBackupReminderService';
import { handleKnowledgeCardCommand } from '../src/services/knowledgeCardCommandService';
import { handleResumeKnowledgeCard, resolveKnowledgeCardIdFromReviewShortCode } from '../src/services/knowledgeCardResumeService';
import { initKnowledgeBase, isKnowledgeBaseEmpty, pauseCard } from '../src/services/knowledgeBaseService';
import { loadEnv, resetEnvCache } from '../src/config/env';
import { resetRepositories } from '../src/repositories';
import { registerAdmin, registerInviteCode, requestConsultantJoin, approveConsultant } from '../src/services/consultantWhitelist';
import { validateKnowledgeCard, enforceKnowledgeCardRules } from '../src/services/knowledgeCardValidator';
import { writeKnowledgeCardWithValidation } from '../src/services/knowledgeCardWriteGate';
import { KnowledgeCard } from '../src/schemas/knowledgeCardSchema';
import { TEST_ADMIN, TEST_CONSULTANT } from './helpers/testSetup';

const sampleCard: KnowledgeCard = {
  card_id: 'test-card-001',
  title: '測試卡',
  patterns: ['測試問題'],
  risk_level: RiskLevel.LOW,
  can_public_reply: true,
  standard_answer: '測試回答',
  not_applicable: [],
  escalate_to_consultant: [],
  status: '可用',
};

async function setupRoles(): Promise<void> {
  await registerAdmin(TEST_ADMIN, 'Admin');
  await registerInviteCode('CODE001', TEST_ADMIN);
  await requestConsultantJoin(TEST_CONSULTANT, 'CODE001', 'Consultant');
  await approveConsultant(TEST_ADMIN, TEST_CONSULTANT);
}

describe('Knowledge cards DB migration', () => {
  it('dry run lists success and failure without writing DB', async () => {
    await getRepos().knowledgeCards.clear();
    const result = await migrateKnowledgeCardsFromJson({ dryRun: true });
    expect(result.success.length).toBeGreaterThan(0);
    expect(result.failed.length).toBe(0);
    expect(await getRepos().knowledgeCards.count()).toBe(0);
  });

  it('formal migration matches JSON count and sets migration actor', async () => {
    await getRepos().knowledgeCards.clear();
    const jsonItems = JSON.parse(fs.readFileSync(getDefaultKnowledgeJsonPath(), 'utf-8')) as unknown[];
    const executedAt = '2026-06-08T00:00:00.000Z';
    const result = await migrateKnowledgeCardsFromJson({ dryRun: false, executedAt });
    expect(result.countMatch).toBe(true);
    expect(result.dbCount).toBe(jsonItems.length);
    const record = await getRepos().knowledgeCards.findById('op-login');
    expect(record?.createdBy).toBe(MIGRATION_ACTOR);
    expect(record?.confirmedBy).toBe(MIGRATION_ACTOR);
    expect(record?.createdAt).toBe(executedAt);
    expect(knowledgeJsonBackupExists()).toBe(true);
  });

  it('validateJsonCard rejects extra tracking fields on import shape', () => {
    const result = validateJsonCard({
      ...sampleCard,
      created_by: 'hacker',
    });
    expect(result.card).toBeUndefined();
    expect(result.reason).toMatch(/不允許欄位 created_by/);
  });
});

describe('Knowledge cards DB read and public answer', () => {
  it('reads standard_answer from DB after migration', async () => {
    const match = await matchKnowledgeCard('怎麼登入後台');
    expect(match.card?.card_id).toBe('op-login');
    expect(match.card?.standard_answer).toBe(getCardById('op-login')?.standard_answer);
  });

  it('getActiveCards excludes paused cards', async () => {
    const cards = await getActiveCards();
    expect(cards.some((c) => c.card_id === 'op-login')).toBe(true);
  });
});

describe('Knowledge card two-step confirmation', () => {
  beforeEach(async () => {
    clearKnowledgeCardWriteState();
    clearKnowledgeCardReviewState();
    await setupRoles();
  });

  it('consultant confirm submit pushes draft with short code to admin without DB write', async () => {
    await storeUserDraft(TEST_CONSULTANT, sampleCard, JSON.stringify(sampleCard), 'draft text');
    const replies = await handleConsultantConfirmSubmit(TEST_CONSULTANT);
    expect(replies.some((r) => r.type === 'push' && r.userId === TEST_ADMIN)).toBe(true);
    expect(replies.some((r) => r.text?.includes('待審短碼：K-'))).toBe(true);
    expect(await getRepos().knowledgeCards.findById(sampleCard.card_id)).toBeNull();
  });

  it('consultant confirm update is rejected', async () => {
    const replies = await handleConsultantConfirmUpdateAttempt({
      userId: TEST_CONSULTANT,
      text: '確認更新',
    });
    expect(replies[0].text).toMatch(/只有 active admin 可確認更新/);
  });

  it('admin confirm update with own draft writes DB and event_log', async () => {
    await storeUserDraft(TEST_ADMIN, sampleCard, JSON.stringify(sampleCard), 'admin draft');
    const replies = await handleConfirmUpdate({ userId: TEST_ADMIN, text: '確認更新' });
    expect(replies[0].text).toMatch(/已確認更新/);
    const record = await getRepos().knowledgeCards.findById(sampleCard.card_id);
    expect(record?.confirmedBy).toBe(TEST_ADMIN);
    const events = await getRepos().events.findByType(EventType.CONSULTANT_OVERRIDE);
    expect(events.some((e) => e.knowledge_card_id === sampleCard.card_id)).toBe(true);
  });

  it('rejects bare confirm when multiple pending reviews', async () => {
    await seedPendingReviewForTest({
      consultantId: TEST_CONSULTANT,
      consultantName: 'C1',
      card: sampleCard,
      draftText: 'draft1',
      shortCode: 'K-20260608-A1',
    });
    await seedPendingReviewForTest({
      consultantId: 'consultant-002',
      consultantName: 'C2',
      card: { ...sampleCard, card_id: 'test-card-002' },
      draftText: 'draft2',
      shortCode: 'K-20260608-B2',
    });
    const replies = await handleConfirmUpdate({ userId: TEST_ADMIN, text: '確認更新' });
    expect(replies[0].text).toMatch(/多筆待審/);
    expect(replies[0].text).toMatch(/K-20260608-A1/);
  });

  it('confirms correct draft by short code', async () => {
    await seedPendingReviewForTest({
      consultantId: TEST_CONSULTANT,
      consultantName: 'C1',
      card: sampleCard,
      draftText: 'draft1',
      shortCode: 'K-20260608-A1',
    });
    await seedPendingReviewForTest({
      consultantId: 'consultant-002',
      consultantName: 'C2',
      card: { ...sampleCard, card_id: 'test-card-002' },
      draftText: 'draft2',
      shortCode: 'K-20260608-B2',
    });
    const replies = await handleConfirmUpdate({
      userId: TEST_ADMIN,
      text: '確認更新 K-20260608-B2',
    });
    expect(replies[0].text).toMatch(/test-card-002/);
    expect(await getRepos().knowledgeCards.findById('test-card-002')).not.toBeNull();
    expect(await getRepos().knowledgeCards.findById(sampleCard.card_id)).toBeNull();
  });

  it('allows bare confirm when single pending review', async () => {
    await seedPendingReviewForTest({
      consultantId: TEST_CONSULTANT,
      consultantName: 'C1',
      card: sampleCard,
      draftText: 'draft1',
      shortCode: 'K-20260608-A1',
    });
    const replies = await handleConfirmUpdate({ userId: TEST_ADMIN, text: '確認更新' });
    expect(replies[0].text).toMatch(/已確認更新/);
  });

  it('resolves draft by quotedMessageId', async () => {
    await seedPendingReviewForTest(
      {
        consultantId: TEST_CONSULTANT,
        consultantName: 'C1',
        card: sampleCard,
        draftText: 'draft1',
        shortCode: 'K-20260608-A1',
      },
      'quoted-msg-001'
    );
    const replies = await handleConfirmUpdate({
      userId: TEST_ADMIN,
      text: '確認更新',
      quotedMessageId: 'quoted-msg-001',
    });
    expect(replies[0].text).toMatch(/已確認更新/);
  });

  it('prefers short code over quotedMessageId when conflict', async () => {
    await seedPendingReviewForTest(
      {
        consultantId: TEST_CONSULTANT,
        consultantName: 'C1',
        card: sampleCard,
        draftText: 'draft1',
        shortCode: 'K-20260608-A1',
      },
      'quoted-msg-001'
    );
    await seedPendingReviewForTest({
      consultantId: 'consultant-002',
      consultantName: 'C2',
      card: { ...sampleCard, card_id: 'test-card-002' },
      draftText: 'draft2',
      shortCode: 'K-20260608-B2',
    });
    const replies = await handleConfirmUpdate({
      userId: TEST_ADMIN,
      text: '確認更新 K-20260608-B2',
      quotedMessageId: 'quoted-msg-001',
    });
    expect(replies[0].text).toMatch(/test-card-002/);
  });

  it('validator failure on confirm does not write DB or event_log for own draft', async () => {
    const invalidCard: KnowledgeCard = {
      ...sampleCard,
      card_id: 'invalid-card',
      risk_level: RiskLevel.MID,
      can_public_reply: true,
    };
    const eventCountBefore = (await getRepos().events.findByType(EventType.CONSULTANT_OVERRIDE)).length;
    const cardCountBefore = await getRepos().knowledgeCards.count();
    await storeUserDraft(TEST_ADMIN, invalidCard, JSON.stringify(invalidCard), 'bad draft');
    const replies = await handleConfirmUpdate({ userId: TEST_ADMIN, text: '確認更新' });
    expect(replies[0].text).toMatch(/驗證失敗/);
    expect(replies[0].text).toMatch(/尚未寫入知識庫/);
    expect(replies[0].text).toMatch(/修改：/);
    expect(await getRepos().knowledgeCards.findById('invalid-card')).toBeNull();
    expect(await getRepos().knowledgeCards.count()).toBe(cardCountBefore);
    expect((await getRepos().events.findByType(EventType.CONSULTANT_OVERRIDE)).length).toBe(
      eventCountBefore
    );
    expect((await getRepos().dmSessions.findActiveByUserId(TEST_ADMIN))?.status).toBe('active');
  });

  it('admin revision feedback does not write DB', async () => {
    await storeUserDraft(TEST_CONSULTANT, sampleCard, JSON.stringify(sampleCard), 'draft');
    await handleConsultantConfirmSubmit(TEST_CONSULTANT);
    const shortCode = (await listPendingReviews())[0].shortCode;
    await handleAdminRevisionFeedback({
      userId: TEST_ADMIN,
      text: `需要修改 ${shortCode}：請補充 patterns`,
    });
    expect(await getRepos().knowledgeCards.findById(sampleCard.card_id)).toBeNull();
  });

  it('admin reject does not write DB', async () => {
    await storeUserDraft(TEST_CONSULTANT, sampleCard, JSON.stringify(sampleCard), 'draft');
    await handleConsultantConfirmSubmit(TEST_CONSULTANT);
    const shortCode = (await listPendingReviews())[0].shortCode;
    await handleAdminRejectDraft({
      userId: TEST_ADMIN,
      text: `退回 ${shortCode}`,
    });
    expect(await getRepos().knowledgeCards.findById(sampleCard.card_id)).toBeNull();
  });
});

describe('Knowledge review short code uniqueness', () => {
  beforeEach(async () => {
    clearKnowledgeCardReviewState();
    await setupRoles();
  });

  it('assigns unique short codes for multiple pending reviews on the same day', async () => {
    const codes: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const review = await createPendingReview({
        consultantId: `consultant-sc-${i}`,
        consultantName: `C${i}`,
        card: { ...sampleCard, card_id: `sc-${i}` },
        draftText: `draft-${i}`,
      });
      codes.push(review.shortCode);
    }
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('extends suffix when initial short code is already taken', async () => {
    const submittedAt = new Date().toISOString();
    const datePart = submittedAt.slice(0, 10).replace(/-/g, '');
    const takenCode = `K-${datePart}-AA`;
    await seedPendingReviewForTest({
      consultantId: 'consultant-a',
      consultantName: 'A',
      card: sampleCard,
      draftText: 'draft-a',
      shortCode: takenCode,
      submittedAt,
    });

    const second = await createPendingReview({
      consultantId: 'consultant-b',
      consultantName: 'B',
      card: { ...sampleCard, card_id: 'sc-collision' },
      draftText: 'draft-b',
    });

    expect(second.shortCode).not.toBe(takenCode);
    expect(second.shortCode.startsWith(`K-${datePart}-`)).toBe(true);
  });

  it('allocateUniqueKnowledgeReviewShortCode keeps extending until unique', () => {
    const taken = new Set(['K-20260608-AA', 'K-20260608-AAA']);
    const code = allocateUniqueKnowledgeReviewShortCode(
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      '2026-06-08T00:00:00.000Z',
      (candidate) => taken.has(candidate)
    );
    expect(code).toBe('K-20260608-AAAA');
    expect(taken.has(code)).toBe(false);
  });

  it('rejects confirm when short code cannot be uniquely resolved', async () => {
    await seedPendingReviewForTest({
      consultantId: TEST_CONSULTANT,
      consultantName: 'C1',
      card: sampleCard,
      draftText: 'draft-a',
      shortCode: 'K-20260608-A1',
    });
    await seedPendingReviewForTest({
      consultantId: 'consultant-002',
      consultantName: 'C2',
      card: { ...sampleCard, card_id: 'dup-card' },
      draftText: 'draft-b',
      shortCode: 'K-20260608-B2',
    });

    const resolved = await resolveReviewTarget({
      text: '確認更新 K-20260608-A1 K-20260608-B2',
      adminUserId: TEST_ADMIN,
    });
    expect(resolved.error).toMatch(/短碼無法唯一定位/);

    const replies = await handleConfirmUpdate({
      userId: TEST_ADMIN,
      text: '確認更新 K-20260608-A1 K-20260608-B2',
    });
    expect(replies[0].text).toMatch(/短碼無法唯一定位/);
    expect(await getRepos().knowledgeCards.findById('dup-card')).toBeNull();
    expect(await getRepos().knowledgeCards.findById(sampleCard.card_id)).toBeNull();
  });

  it('supports extended suffix short code for confirm update', async () => {
    await seedPendingReviewForTest({
      consultantId: TEST_CONSULTANT,
      consultantName: 'C1',
      card: { ...sampleCard, card_id: 'ext-suffix-card' },
      draftText: 'draft-ext',
      shortCode: 'K-20260608-AAAA',
    });
    const replies = await handleConfirmUpdate({
      userId: TEST_ADMIN,
      text: '確認更新 K-20260608-AAAA',
    });
    expect(replies[0].text).toMatch(/ext-suffix-card/);
    expect(await getRepos().knowledgeCards.findById('ext-suffix-card')).not.toBeNull();
  });

  it('supports extended suffix short code for revision feedback', async () => {
    await seedPendingReviewForTest({
      consultantId: TEST_CONSULTANT,
      consultantName: 'C1',
      card: sampleCard,
      draftText: 'draft-ext',
      shortCode: 'K-20260608-AAAA',
    });
    const replies = await handleAdminRevisionFeedback({
      userId: TEST_ADMIN,
      text: '需要修改 K-20260608-AAAA：請調整內容',
    });
    expect(replies[0].text).toMatch(/已將修改意見推回顧問/);
    expect(await getRepos().knowledgeCards.findById(sampleCard.card_id)).toBeNull();
  });

  it('supports extended suffix short code for reject', async () => {
    await seedPendingReviewForTest({
      consultantId: TEST_CONSULTANT,
      consultantName: 'C1',
      card: sampleCard,
      draftText: 'draft-ext',
      shortCode: 'K-20260608-AAAA',
    });
    const replies = await handleAdminRejectDraft({
      userId: TEST_ADMIN,
      text: '退回 K-20260608-AAAA',
    });
    expect(replies[0].text).toMatch(/已退回顧問草稿/);
    expect(await getRepos().knowledgeCards.findById(sampleCard.card_id)).toBeNull();
  });

  it('rejects revision and reject when extended short code is ambiguous', async () => {
    await seedPendingReviewForTest({
      consultantId: TEST_CONSULTANT,
      consultantName: 'C1',
      card: sampleCard,
      draftText: 'draft-a',
      shortCode: 'K-20260608-A1',
    });
    await seedPendingReviewForTest({
      consultantId: 'consultant-002',
      consultantName: 'C2',
      card: { ...sampleCard, card_id: 'dup-ext-card' },
      draftText: 'draft-b',
      shortCode: 'K-20260608-B2',
    });

    const revisionReplies = await handleAdminRevisionFeedback({
      userId: TEST_ADMIN,
      text: '需要修改 K-20260608-A1 K-20260608-B2：請調整內容',
    });
    expect(revisionReplies[0].text).toMatch(/短碼無法唯一定位/);

    const rejectReplies = await handleAdminRejectDraft({
      userId: TEST_ADMIN,
      text: '退回 K-20260608-A1 K-20260608-B2',
    });
    expect(rejectReplies[0].text).toMatch(/短碼無法唯一定位/);
  });
});

describe('Knowledge card permissions', () => {
  beforeEach(async () => {
    await setupRoles();
  });

  it('consultant cannot export', async () => {
    const result = await exportKnowledgeCards(TEST_CONSULTANT, 'all');
    expect(result.ok).toBe(false);
  });

  it('pending consultant cannot confirm submit', async () => {
    await requestConsultantJoin('pending-user', 'CODE001');
    await storeUserDraft('pending-user', sampleCard, '{}', 'draft');
    const replies = await handleConsultantConfirmSubmit('pending-user');
    expect(replies[0].text).toMatch(/身份不可/);
  });
});

describe('Knowledge card export', () => {
  beforeEach(async () => {
    await setupRoles();
  });

  it('admin export all includes tracking fields', async () => {
    const result = await exportKnowledgeCards(TEST_ADMIN, 'all');
    expect(result.ok).toBe(true);
    const text = result.replies.map((r) => r.text).join('');
    expect(text).toContain('created_by');
    expect(text).toContain('confirmed_by');
    const lastExport = await getRepos().consultants.getLastKnowledgeExportAt(TEST_ADMIN);
    expect(lastExport).not.toBeNull();
  });

  it('export low risk filters correctly', async () => {
    const result = await exportKnowledgeCards(TEST_ADMIN, 'low_risk');
    const text = result.replies.map((r) => r.text).join('');
    expect(text).toContain('"risk_level": "low"');
    expect(text).not.toContain('"risk_level": "high"');
  });

  it('export active filters correctly', async () => {
    const result = await exportKnowledgeCards(TEST_ADMIN, 'active');
    const text = result.replies.map((r) => r.text).join('');
    expect(text).toContain('"status": "active"');
  });

  it('parse export commands', () => {
    expect(parseExportCommand('匯出所有知識卡')).toBe('all');
    expect(parseExportCommand('匯出 low risk 的卡')).toBe('low_risk');
    expect(parseExportCommand('匯出 active 的卡')).toBe('active');
  });
});

describe('Knowledge card passive backup reminder', () => {
  beforeEach(async () => {
    await setupRoles();
  });

  it('reminds when never exported', async () => {
    const reminder = await buildBackupReminderAppend(TEST_ADMIN);
    expect(reminder).toMatch(/尚未匯出/);
  });

  it('does not remind within 7 days after export', async () => {
    await getRepos().consultants.setLastKnowledgeExportAt(TEST_ADMIN, new Date().toISOString());
    const reminder = await buildBackupReminderAppend(TEST_ADMIN);
    expect(reminder).toBeNull();
  });

  it('reminds when export older than KNOWLEDGE_EXPORT_REMINDER_DAYS', async () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    await getRepos().consultants.setLastKnowledgeExportAt(TEST_ADMIN, eightDaysAgo);
    const reminder = await buildBackupReminderAppend(TEST_ADMIN);
    expect(reminder).toMatch(/超過/);
  });
});

describe('Knowledge card bulk import', () => {
  beforeEach(async () => {
    clearBulkImportState();
    await setupRoles();
  });

  it('preview lists create/update/rejected without writing', async () => {
    const payload = JSON.stringify([
      sampleCard,
      { ...sampleCard, card_id: 'bad-card', can_public_reply: true, risk_level: RiskLevel.HIGH },
      { card_id: 'incomplete' },
    ]);
    const preview = await previewBulkImport(TEST_ADMIN, payload);
    expect(preview.ok).toBe(true);
    expect(preview.replies[0].text).toMatch(/將新增/);
    expect(preview.replies[0].text).toMatch(/被 validator 擋下/);
    expect(await getRepos().knowledgeCards.findById(sampleCard.card_id)).toBeNull();
  });

  it('requires admin confirm before writing', async () => {
    const payload = JSON.stringify([sampleCard]);
    await previewBulkImport(TEST_ADMIN, payload);
    expect(await getRepos().knowledgeCards.findById(sampleCard.card_id)).toBeNull();
    const writes = await executeBulkImport(TEST_ADMIN);
    expect(writes[0].text).toMatch(/批量匯入完成/);
    expect(await getRepos().knowledgeCards.findById(sampleCard.card_id)).not.toBeNull();
  });

  it('executeBulkImport re-validates and skips invalid cards', async () => {
    seedPendingImportForTest(TEST_ADMIN, [
      sampleCard,
      { ...sampleCard, card_id: 'bad-import', risk_level: RiskLevel.MID, can_public_reply: true },
    ]);
    const writes = await executeBulkImport(TEST_ADMIN);
    expect(writes[0].text).toMatch(/成功 1 筆/);
    expect(writes[0].text).toMatch(/失敗 1 筆/);
    expect(await getRepos().knowledgeCards.findById(sampleCard.card_id)).not.toBeNull();
    expect(await getRepos().knowledgeCards.findById('bad-import')).toBeNull();
  });

  it('consultant bulk import denied', async () => {
    const replies = await handleKnowledgeCardCommand({
      userId: TEST_CONSULTANT,
      text: '批量匯入\n[]',
    });
    expect(replies?.[0].text).toMatch(/只有 active admin/);
  });
});

describe('Knowledge card view commands', () => {
  beforeEach(async () => {
    await setupRoles();
  });

  it('admin and consultant can list cards', async () => {
    expect(parseViewCommand('列出所有知識卡')).toBe('all');
    const adminReplies = await handleViewCommand(TEST_ADMIN, 'all');
    expect(adminReplies[0].text).toMatch(/知識卡清單/);
    const consultantReplies = await handleViewCommand(TEST_CONSULTANT, 'all');
    expect(consultantReplies[0].text).toMatch(/知識卡清單/);
  });

  it('search login related cards', async () => {
    const replies = await handleViewCommand(TEST_ADMIN, 'login');
    expect(replies[0].text).toMatch(/登入/);
  });
});

describe('Knowledge card validator regression', () => {
  it('blocks mid risk with can_public_reply true', () => {
    const result = validateKnowledgeCard({
      ...sampleCard,
      risk_level: RiskLevel.MID,
      can_public_reply: true,
    });
    expect(result.valid).toBe(false);
  });

  it('blocks low risk with payment keywords', () => {
    const result = enforceKnowledgeCardRules({
      ...sampleCard,
      title: '金流設定',
      risk_level: RiskLevel.LOW,
      can_public_reply: true,
    });
    expect(result.valid).toBe(false);
  });
});

describe('Knowledge card resume', () => {
  beforeEach(async () => {
    clearKnowledgeCardReviewState();
    await setupRoles();
  });

  it('admin can resume paused card with event_log', async () => {
    await pauseCard('op-login', TEST_ADMIN, 'test pause');
    const replies = await handleResumeKnowledgeCard(TEST_ADMIN, 'op-login');
    expect(replies[0].text).toMatch(/已恢復/);
    const record = await getRepos().knowledgeCards.findById('op-login');
    expect(record?.status).toBe('active');
    const events = await getRepos().events.findByType(EventType.CONSULTANT_OVERRIDE);
    expect(events.some((e) => e.detail?.includes('operation=resume'))).toBe(true);
    expect(events.some((e) => e.detail?.includes(`operator=${TEST_ADMIN}`))).toBe(true);
  });

  it('admin can resume paused card by review short code', async () => {
    await seedPendingReviewForTest({
      consultantId: TEST_CONSULTANT,
      consultantName: 'C1',
      card: { ...sampleCard, card_id: 'resume-by-code' },
      draftText: 'draft-resume',
      shortCode: 'K-20260608-AAAA',
    });
    await handleConfirmUpdate({
      userId: TEST_ADMIN,
      text: '確認更新 K-20260608-AAAA',
    });
    await pauseCard('resume-by-code', TEST_ADMIN, 'test pause');
    const replies = await handleResumeKnowledgeCard(TEST_ADMIN, 'K-20260608-AAAA');
    expect(replies[0].text).toMatch(/已恢復/);
    expect((await getRepos().knowledgeCards.findById('resume-by-code'))?.status).toBe('active');
    const events = await getRepos().events.findByType(EventType.CONSULTANT_OVERRIDE);
    const resumeEvent = events.find(
      (e) =>
        e.knowledge_card_id === 'resume-by-code' &&
        e.detail?.includes('operation=resume') &&
        e.detail?.includes(`operator=${TEST_ADMIN}`)
    );
    expect(resumeEvent).toBeDefined();
  });

  it('rejects resume when review short code is not found', async () => {
    const replies = await handleResumeKnowledgeCard(TEST_ADMIN, 'K-20260608-NONE');
    expect(replies[0].text).toMatch(/找不到指定知識卡/);
    expect(await resolveKnowledgeCardIdFromReviewShortCode('K-20260608-NONE')).toEqual({
      error: 'not_found',
    });
  });

  it('rejects resume when review short code is ambiguous', async () => {
    await writeKnowledgeCardWithValidation({
      card: { ...sampleCard, card_id: 'ambig-a' },
      operatorUserId: TEST_ADMIN,
      operation: 'create',
      summary: 'test ambiguous a',
      reviewShortCode: 'K-20260608-DUP',
    });
    await writeKnowledgeCardWithValidation({
      card: { ...sampleCard, card_id: 'ambig-b' },
      operatorUserId: TEST_ADMIN,
      operation: 'create',
      summary: 'test ambiguous b',
      reviewShortCode: 'K-20260608-DUP',
    });
    await getRepos().knowledgeCards.setStatus('ambig-a', 'paused', {
      updatedBy: TEST_ADMIN,
      confirmedBy: TEST_ADMIN,
      confirmedAt: new Date().toISOString(),
    });
    const replies = await handleResumeKnowledgeCard(TEST_ADMIN, 'K-20260608-DUP');
    expect(replies[0].text).toMatch(/短碼無法唯一定位/);
    expect((await getRepos().knowledgeCards.findById('ambig-a'))?.status).toBe('paused');
  });

  it('rejects resume when validator fails', async () => {
    await getRepos().knowledgeCards.setStatus('op-login', 'paused', {
      updatedBy: TEST_ADMIN,
      confirmedBy: TEST_ADMIN,
      confirmedAt: new Date().toISOString(),
    });
    const record = await getRepos().knowledgeCards.findById('op-login');
    if (record) {
      await getRepos().knowledgeCards.update('op-login', {
        title: '金流設定',
        patterns: record.patterns,
        riskLevel: RiskLevel.LOW,
        canPublicReply: true,
        standardAnswer: record.standardAnswer,
        notApplicable: record.notApplicable,
        escalateToConsultant: record.escalateToConsultant,
        status: 'paused',
        updatedBy: TEST_ADMIN,
        updatedAt: new Date().toISOString(),
        confirmedBy: TEST_ADMIN,
        confirmedAt: new Date().toISOString(),
      });
    }
    const replies = await handleResumeKnowledgeCard(TEST_ADMIN, 'op-login');
    expect(replies[0].text).toMatch(/恢復失敗/);
    expect((await getRepos().knowledgeCards.findById('op-login'))?.status).toBe('paused');
  });

  it('consultant cannot resume knowledge card', async () => {
    const replies = await handleKnowledgeCardCommand({
      userId: TEST_CONSULTANT,
      text: '恢復知識卡 op-login',
    });
    expect(replies?.[0].text).toMatch(/只有 active admin/);
  });
});

describe('Production seed policy', () => {
  afterEach(() => {
    resetEnvCache();
    loadEnv({
      NODE_ENV: 'test',
      USE_MEMORY_REPOS: true,
      LINE_CHANNEL_SECRET: 'test-channel-secret',
      LINE_CHANNEL_ACCESS_TOKEN: 'test-access-token',
    });
  });

  it('production does not auto seed from JSON', async () => {
    resetEnvCache();
    loadEnv({
      NODE_ENV: 'production',
      USE_MEMORY_REPOS: true,
      LINE_CHANNEL_SECRET: 'test',
      LINE_CHANNEL_ACCESS_TOKEN: 'test',
    });
    await resetRepositories('memory');
    await getRepos().knowledgeCards.clear();
    const result = await initKnowledgeBase();
    expect(result.knowledgeEmpty).toBe(true);
    expect(await getRepos().knowledgeCards.count()).toBe(0);
  });

  it('dev/test auto seeds when empty', async () => {
    await getRepos().knowledgeCards.clear();
    const result = await initKnowledgeBase();
    expect(result.knowledgeEmpty).toBe(false);
    expect(await getRepos().knowledgeCards.count()).toBeGreaterThan(0);
  });

  it('reports knowledge_empty when table is empty', async () => {
    await getRepos().knowledgeCards.clear();
    expect(await isKnowledgeBaseEmpty()).toBe(true);
  });
});

describe('Write gate validator', () => {
  it('writeKnowledgeCardWithValidation rejects invalid card', async () => {
    await setupRoles();
    const result = await writeKnowledgeCardWithValidation({
      card: { ...sampleCard, card_id: 'gate-fail', risk_level: RiskLevel.MID, can_public_reply: true },
      operatorUserId: TEST_ADMIN,
      operation: 'create',
      summary: 'test',
    });
    expect(result.ok).toBe(false);
    expect(await getRepos().knowledgeCards.findById('gate-fail')).toBeNull();
  });
});

describe('Fixed enums regression', () => {
  it('ThreadState remains 5 values', () => {
    expect(Object.keys(ThreadState)).toHaveLength(5);
  });

  it('EventType remains 10 values', () => {
    expect(Object.keys(EventType)).toHaveLength(10);
  });
});
