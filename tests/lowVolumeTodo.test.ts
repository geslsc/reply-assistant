import * as fs from 'fs';
import * as path from 'path';
import { EventType, RiskLevel } from '../src/types';
import { loadEnv, resetEnvCache } from '../src/config/env';
import { getRepos } from '../src/repositories';
import {
  PendingHandoffInvalidReason,
  PendingHandoffStatus,
} from '../src/repositories/pendingHandoffTypes';
import {
  createPendingHandoff,
  getPendingHandoffs,
  handleIgnoreHandoff,
  handleResolveHandoff,
  handleSnoozeHandoff,
  invalidatePendingHandoff,
  invalidatePendingHandoffsByGroup,
} from '../src/services/pendingHandoffService';
import { markHandoffResolved, updateHandoffStatus } from '../src/services/handoffStatusService';
import { getEventsByType } from '../src/services/eventLogService';
import {
  handleAdminEditDraft,
  handleBatchConfirmUpdate,
  handleConfirmUpdate,
} from '../src/services/knowledgeCardWriteService';
import * as writeGate from '../src/services/knowledgeCardWriteGate';
import * as lowVolumeTodoEventLogService from '../src/services/lowVolumeTodoEventLogService';
import {
  ADMIN_USAGE_GUIDE,
  CONSULTANT_USAGE_GUIDE,
} from '../src/services/knowledgeCardUsageGuideService';
import { seedPendingReviewForTest } from '../src/services/knowledgeCardReviewService';
import { KnowledgeCard } from '../src/schemas/knowledgeCardSchema';
import {
  enableRoundQuietForGroup,
  isRoundQuietActive,
  shouldSkipAutoReplyForThread,
} from '../src/services/roundQuietService';
import { createIssueThread, getActiveIssueThread } from '../src/services/issueThreadService';
import { CHITCHAT_REDIRECT_POOL } from '../src/services/groupReplyCopyService';
import { applySemanticClassification } from '../src/services/groupConvergenceActionService';
import { classifyConsultantIntent, ConsultantIntent } from '../src/services/consultantIntentClassifier';
import { handleConsultantMute } from '../src/services/consultantGroupControlService';
import { registerAdmin } from '../src/services/consultantWhitelist';
import {
  resetTestState,
  TEST_ADMIN,
  TEST_CONSULTANT,
  TEST_GROUP,
} from './helpers/testSetup';

const validCard: KnowledgeCard = {
  card_id: 'low-volume-valid',
  title: '後台操作教學',
  patterns: ['怎麼操作後台'],
  risk_level: RiskLevel.LOW,
  can_public_reply: true,
  standard_answer: '請至設定頁完成操作',
  not_applicable: [],
  escalate_to_consultant: [],
  status: '可用',
};

const invalidCard: KnowledgeCard = {
  ...validCard,
  card_id: 'low-volume-invalid',
  risk_level: RiskLevel.MID,
  can_public_reply: true,
};

describe('low volume todo query type', () => {
  beforeEach(async () => {
    resetEnvCache();
    loadEnv({ USE_MEMORY_REPOS: true, ENABLE_GROUP_PROXY_REPLY: false });
    await resetTestState();
    await registerAdmin(TEST_ADMIN);
  });

  describe('pending_handoffs status fields', () => {
    it('updates status with audit fields and logs handoff_status_changed', async () => {
      const thread = await createIssueThread(TEST_GROUP, 'Q');
      const handoff = await createPendingHandoff({
        consultantId: TEST_CONSULTANT,
        issueThreadId: thread.issueThreadId,
        groupId: TEST_GROUP,
        shortCode: 'Q-20260611-0100-A1',
        customerQuestion: 'Q',
      });

      await updateHandoffStatus({
        id: handoff.id,
        status: PendingHandoffStatus.IN_PROGRESS,
        updatedBy: TEST_CONSULTANT,
      });

      const updated = (await getPendingHandoffs(TEST_CONSULTANT)).find((h) => h.id === handoff.id);
      expect(updated?.status).toBe(PendingHandoffStatus.IN_PROGRESS);
      expect(updated?.statusUpdatedBy).toBe(TEST_CONSULTANT);
      expect(updated?.statusUpdatedAt).toBeTruthy();
      expect(updated?.reason).toBeNull();

      await markHandoffResolved(handoff.id, TEST_CONSULTANT);
      const resolved = (await getPendingHandoffs(TEST_CONSULTANT)).find((h) => h.id === handoff.id);
      expect(resolved?.status).toBe(PendingHandoffStatus.RESOLVED);

      const events = await getEventsByType(EventType.CONSULTANT_OVERRIDE);
      const resolvedEvent = events.find((e) => e.detail?.includes('"to_status":"resolved"'));
      expect(resolvedEvent).toBeDefined();
      const detail = JSON.parse(resolvedEvent!.detail!);
      expect(detail.action).toBe('handoff_status_changed');
      expect(detail.from_status).toBe(PendingHandoffStatus.IN_PROGRESS);
      expect(detail.to_status).toBe(PendingHandoffStatus.RESOLVED);
      expect(detail.handoff_id).toBe(handoff.id);
      expect(detail.updated_by).toBe(TEST_CONSULTANT);
      expect(detail.customerQuestion).toBeUndefined();
    });

    it('stores reason only when ignored and logs from_status', async () => {
      const thread = await createIssueThread(TEST_GROUP, 'Q');
      const handoff = await createPendingHandoff({
        consultantId: TEST_CONSULTANT,
        issueThreadId: thread.issueThreadId,
        groupId: TEST_GROUP,
        shortCode: 'Q-20260611-0200-B2',
        customerQuestion: 'Q',
      });

      await invalidatePendingHandoff(handoff.id, PendingHandoffInvalidReason.PASSIVE_TIMEOUT);
      const ignored = (await getPendingHandoffs(TEST_CONSULTANT)).find((h) => h.id === handoff.id);
      expect(ignored?.status).toBe(PendingHandoffStatus.IGNORED);
      expect(ignored?.reason).toBe(PendingHandoffInvalidReason.PASSIVE_TIMEOUT);

      const events = await getEventsByType(EventType.CONSULTANT_OVERRIDE);
      const detail = JSON.parse(
        events.find((e) => e.detail?.includes(handoff.id))!.detail!
      );
      expect(detail.from_status).toBe(PendingHandoffStatus.PENDING);
      expect(detail.to_status).toBe(PendingHandoffStatus.IGNORED);
      expect(detail.reason).toBe(PendingHandoffInvalidReason.PASSIVE_TIMEOUT);
    });

    it('batch ignore writes per-handoff audit logs with system_batch_ignore source', async () => {
      const thread = await createIssueThread(TEST_GROUP, 'Q1');
      const handoff1 = await createPendingHandoff({
        consultantId: TEST_CONSULTANT,
        issueThreadId: thread.issueThreadId,
        groupId: TEST_GROUP,
        shortCode: 'Q-20260611-0400-D4',
        customerQuestion: 'Q1',
      });
      const thread2 = await createIssueThread(TEST_GROUP, 'Q2');
      const handoff2 = await createPendingHandoff({
        consultantId: TEST_CONSULTANT,
        issueThreadId: thread2.issueThreadId,
        groupId: TEST_GROUP,
        shortCode: 'Q-20260611-0500-E5',
        customerQuestion: 'Q2',
      });

      await invalidatePendingHandoffsByGroup(TEST_GROUP, PendingHandoffInvalidReason.GROUP_MUTED);

      const events = await getEventsByType(EventType.CONSULTANT_OVERRIDE);
      const batchLogs = events
        .map((e) => {
          try {
            return JSON.parse(e.detail!);
          } catch {
            return null;
          }
        })
        .filter(
          (d): d is Record<string, unknown> =>
            Boolean(
              d &&
                d.action === 'handoff_status_changed' &&
                d.source === 'system_batch_ignore' &&
                [handoff1.id, handoff2.id].includes(String(d.handoff_id))
            )
        );
      expect(batchLogs).toHaveLength(2);
      expect(batchLogs.every((d) => d.from_status === PendingHandoffStatus.PENDING)).toBe(true);
      expect(batchLogs.every((d) => d.to_status === PendingHandoffStatus.IGNORED)).toBe(true);
      expect(batchLogs.every((d) => d.reason === PendingHandoffInvalidReason.GROUP_MUTED)).toBe(
        true
      );
    });

    it('consultant mute batch ignore logs each handoff independently', async () => {
      const thread = await createIssueThread(TEST_GROUP, 'Q');
      const handoff = await createPendingHandoff({
        consultantId: TEST_CONSULTANT,
        issueThreadId: thread.issueThreadId,
        groupId: TEST_GROUP,
        shortCode: 'Q-20260611-0600-F6',
        customerQuestion: 'Q',
      });

      await handleConsultantMute(TEST_GROUP, TEST_CONSULTANT, true);

      const events = await getEventsByType(EventType.CONSULTANT_OVERRIDE);
      const detail = JSON.parse(
        events.find(
          (e) => e.detail?.includes(handoff.id) && e.detail?.includes('system_batch_ignore')
        )!.detail!
      );
      expect(detail.from_status).toBe(PendingHandoffStatus.PENDING);
      expect(detail.to_status).toBe(PendingHandoffStatus.IGNORED);
      expect(detail.reason).toBe(PendingHandoffInvalidReason.GROUP_MUTED);
    });

    it('snooze moves actionable handoff to in_progress', async () => {
      const thread = await createIssueThread(TEST_GROUP, 'Q');
      await createPendingHandoff({
        consultantId: TEST_CONSULTANT,
        issueThreadId: thread.issueThreadId,
        groupId: TEST_GROUP,
        shortCode: 'Q-20260611-0300-C3',
        customerQuestion: 'Q',
      });
      await handleSnoozeHandoff(TEST_CONSULTANT);
      const handoffs = await getPendingHandoffs(TEST_CONSULTANT);
      expect(handoffs[0].status).toBe(PendingHandoffStatus.IN_PROGRESS);
      expect(handoffs[0].snoozed).toBe(true);
    });

    it('listed pending handoff actions resolve or ignore by short code', async () => {
      const thread = await createIssueThread(TEST_GROUP, 'Q');
      const resolved = await createPendingHandoff({
        consultantId: TEST_CONSULTANT,
        issueThreadId: thread.issueThreadId,
        groupId: TEST_GROUP,
        shortCode: 'Q-20260611-0300-C4',
        customerQuestion: 'Q1',
      });
      const ignored = await createPendingHandoff({
        consultantId: TEST_CONSULTANT,
        issueThreadId: thread.issueThreadId,
        groupId: TEST_GROUP,
        shortCode: 'Q-20260611-0300-C5',
        customerQuestion: 'Q2',
      });

      const resolveReplies = await handleResolveHandoff(TEST_CONSULTANT, resolved.shortCode);
      const ignoreReplies = await handleIgnoreHandoff(TEST_CONSULTANT, ignored.shortCode);

      expect(resolveReplies[0].text).toContain('不會再出現在待處理清單');
      expect(ignoreReplies[0].text).toContain('不會再出現在待處理清單');
      const all = await getPendingHandoffs(TEST_CONSULTANT);
      expect(all.find((h) => h.id === resolved.id)?.status).toBe(PendingHandoffStatus.RESOLVED);
      expect(all.find((h) => h.id === ignored.id)?.status).toBe(PendingHandoffStatus.IGNORED);
      expect(all.find((h) => h.id === ignored.id)?.reason).toBe('manual_ignore');
    });
  });

  describe('admin edit draft flow', () => {
    it('updates draft_data and still requires confirm update + validation', async () => {
      await seedPendingReviewForTest({
        consultantId: TEST_CONSULTANT,
        consultantName: 'Consultant',
        card: validCard,
        draftText: 'draft',
        shortCode: 'K-20260611-ED1',
      });

      const editedCard = { ...validCard, title: '後台操作教學（修訂版）' };
      const editReplies = await handleAdminEditDraft({
        userId: TEST_ADMIN,
        text: `編輯草稿 K-20260611-ED1 原因：補標題\n${JSON.stringify(editedCard)}`,
      });
      expect(editReplies[0].text).toMatch(/已更新草稿/);
      expect(editReplies[0].text).toMatch(/確認更新/);

      const record = await getRepos().pendingKnowledgeReviews.findById('K-20260611-ED1');
      expect(record?.lastEditedBy).toBe(TEST_ADMIN);
      expect(record?.lastEditedAt).toBeTruthy();
      expect(record?.editReason).toBe('補標題');
      expect(record?.draftData?.title).toBe('後台操作教學（修訂版）');
      expect(await getRepos().knowledgeCards.findById('low-volume-valid')).toBeNull();

      const confirmReplies = await handleConfirmUpdate({
        userId: TEST_ADMIN,
        text: '確認更新 K-20260611-ED1',
      });
      expect(confirmReplies[0].text).toMatch(/已新增知識卡|已更新知識卡/);
      expect(await getRepos().knowledgeCards.findById('low-volume-valid')).not.toBeNull();

      const events = await getEventsByType(EventType.CONSULTANT_OVERRIDE);
      expect(events.some((e) => e.detail?.includes('knowledge_draft_edited'))).toBe(true);
    });

    it('succeeds when knowledge_draft_edited log throws', async () => {
      await seedPendingReviewForTest({
        consultantId: TEST_CONSULTANT,
        consultantName: 'Consultant',
        card: validCard,
        draftText: 'draft',
        shortCode: 'K-20260611-LOG1',
      });

      const logSpy = jest
        .spyOn(lowVolumeTodoEventLogService, 'logKnowledgeDraftEdited')
        .mockRejectedValueOnce(new Error('simulated log failure'));

      const editedCard = { ...validCard, title: '後台操作教學（log 測試）' };
      const editReplies = await handleAdminEditDraft({
        userId: TEST_ADMIN,
        text: `編輯草稿 K-20260611-LOG1\n${JSON.stringify(editedCard)}`,
      });

      expect(editReplies[0].text).toMatch(/已更新草稿/);
      const record = await getRepos().pendingKnowledgeReviews.findById('K-20260611-LOG1');
      expect(record?.draftData?.title).toBe('後台操作教學（log 測試）');
      expect(record?.status).toBe('pending');

      logSpy.mockRestore();
    });
  });

  describe('documentation does not expose group proxy reply syntax', () => {
    const forbiddenPatterns = [
      /Q-YYYYMMDD/i,
      /代回群組/,
      /指定短碼代回/,
      /回覆這題/,
      /幫我回群組/,
      /確認代回/,
    ];

    it('CONSULTANT_MANUAL and README omit group proxy syntax', () => {
      for (const file of ['CONSULTANT_MANUAL.md', 'README.md']) {
        const content = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
        for (const pattern of forbiddenPatterns) {
          expect(content).not.toMatch(pattern);
        }
      }
    });

    it('usage guides omit group proxy syntax', () => {
      for (const guide of [ADMIN_USAGE_GUIDE, CONSULTANT_USAGE_GUIDE]) {
        for (const pattern of forbiddenPatterns) {
          expect(guide).not.toMatch(pattern);
        }
      }
    });
  });

  describe('batch confirm per-item commit', () => {
    it('commits successes independently and keeps failures pending', async () => {
      await seedPendingReviewForTest({
        consultantId: TEST_CONSULTANT,
        consultantName: 'Consultant',
        card: validCard,
        draftText: 'ok',
        shortCode: 'K-20260611-OK1',
      });
      await seedPendingReviewForTest({
        consultantId: TEST_CONSULTANT,
        consultantName: 'Consultant',
        card: invalidCard,
        draftText: 'bad',
        shortCode: 'K-20260611-BAD1',
      });

      const replies = await handleBatchConfirmUpdate({
        userId: TEST_ADMIN,
        text: '確認更新 K-20260611-OK1 K-20260611-BAD1',
      });

      expect(replies[0].text).toMatch(/成功 1 筆/);
      expect(replies[0].text).toMatch(/K-20260611-OK1/);
      expect(replies[0].text).toMatch(/失敗 1 筆/);
      expect(replies[0].text).toMatch(/K-20260611-BAD1/);

      expect(await getRepos().knowledgeCards.findById('low-volume-valid')).not.toBeNull();
      expect(await getRepos().knowledgeCards.findById('low-volume-invalid')).toBeNull();
      expect((await getRepos().pendingKnowledgeReviews.findById('K-20260611-BAD1'))?.status).toBe(
        'pending'
      );
    });

    it('continues processing when single handleConfirmUpdate throws', async () => {
      await seedPendingReviewForTest({
        consultantId: TEST_CONSULTANT,
        consultantName: 'Consultant',
        card: validCard,
        draftText: 'ok',
        shortCode: 'K-20260611-OK2',
      });
      await seedPendingReviewForTest({
        consultantId: TEST_CONSULTANT,
        consultantName: 'Consultant',
        card: { ...validCard, card_id: 'low-volume-throw' },
        draftText: 'ok2',
        shortCode: 'K-20260611-THROW1',
      });

      const { writeKnowledgeCardWithValidation: realWrite } = jest.requireActual<
        typeof import('../src/services/knowledgeCardWriteGate')
      >('../src/services/knowledgeCardWriteGate');
      const writeSpy = jest.spyOn(writeGate, 'writeKnowledgeCardWithValidation');
      writeSpy.mockImplementation(async (params) => {
        if (params.card.card_id === 'low-volume-throw') {
          throw new Error('simulated batch throw');
        }
        return realWrite(params);
      });

      const replies = await handleBatchConfirmUpdate({
        userId: TEST_ADMIN,
        text: '確認更新 K-20260611-OK2 K-20260611-THROW1',
      });

      expect(replies[0].text).toMatch(/成功 1 筆/);
      expect(replies[0].text).toMatch(/K-20260611-OK2/);
      expect(replies[0].text).toMatch(/失敗 1 筆/);
      expect(replies[0].text).toMatch(/simulated batch throw/);
      expect(await getRepos().knowledgeCards.findById('low-volume-valid')).not.toBeNull();
      expect((await getRepos().pendingKnowledgeReviews.findById('K-20260611-THROW1'))?.status).toBe(
        'pending'
      );

      writeSpy.mockRestore();
    });
  });

  describe('round quiet for current issue thread only', () => {
    it('blocks auto reply only for active thread and resets on new thread', async () => {
      const thread1 = await createIssueThread(TEST_GROUP, 'Q1');
      expect(await enableRoundQuietForGroup(TEST_GROUP)).toBe(true);
      expect(await isRoundQuietActive(TEST_GROUP)).toBe(true);
      expect(shouldSkipAutoReplyForThread({ autoReplyBlocked: true })).toBe(true);

      const active = await getActiveIssueThread(TEST_GROUP);
      expect(active?.issueThreadId).toBe(thread1.issueThreadId);
      expect(active?.autoReplyBlocked).toBe(true);

      const eventsBefore = (await getEventsByType(EventType.CONSULTANT_OVERRIDE)).length;
      const chitchatReplies = await applySemanticClassification({
        groupId: TEST_GROUP,
        issueThreadId: thread1.issueThreadId,
        customerUserId: 'customer-001',
        question: '你好',
        classification: {
          intentClear: false,
          cardId: null,
          confidence: 'low',
          clarifyQuestion: null,
          summary: 'hi',
          usedLlm: false,
          isChitchat: true,
        },
        clarifyRound: 0,
      });
      expect(chitchatReplies).toHaveLength(0);

      await createIssueThread(TEST_GROUP, 'Q2');
      expect(await isRoundQuietActive(TEST_GROUP)).toBe(false);
      expect((await getEventsByType(EventType.CONSULTANT_OVERRIDE)).length).toBe(eventsBefore);
    });
  });

  describe('chitchat branch', () => {
    it('returns short reply without triggering handoff or knowledge flow', async () => {
      const thread = await createIssueThread(TEST_GROUP, 'Q');
      const replies = await applySemanticClassification({
        groupId: TEST_GROUP,
        issueThreadId: thread.issueThreadId,
        customerUserId: 'customer-001',
        question: '今天天氣真好',
        classification: {
          intentClear: false,
          cardId: null,
          confidence: 'low',
          clarifyQuestion: null,
          summary: 'chitchat',
          usedLlm: true,
          isChitchat: true,
        },
        clarifyRound: 0,
      });
      expect(replies).toHaveLength(1);
      expect(
        CHITCHAT_REDIRECT_POOL.some((pool) => replies[0].text?.includes(pool)),
      ).toBe(true);
      expect(await getRepos().pendingHandoffs.findActionableByConsultant(TEST_CONSULTANT)).toHaveLength(
        0
      );
    });
  });

  describe('group proxy reply disabled by default', () => {
    it('does not classify REPLY_TO_GROUP from natural language', () => {
      expect(classifyConsultantIntent('代回群組：測試').intent).toBe(ConsultantIntent.UNKNOWN);
      expect(classifyConsultantIntent('Q-20260611-0100-A1 測試').intent).toBe(
        ConsultantIntent.UNKNOWN
      );
    });
  });

  describe('push_usage_logs reserved table', () => {
    it('exists in schema for future use', () => {
      const fs = require('fs');
      const path = require('path');
      const schema = fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8');
      expect(schema).toContain('CREATE TABLE IF NOT EXISTS push_usage_logs');
    });
  });
});
