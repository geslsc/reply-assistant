import { processMessage } from '../src/handlers/lineWebhookHandler';
import { mapLeaveEvent } from '../src/routes/lineWebhook';
import { getRepos } from '../src/repositories';
import { getEventsByType } from '../src/services/eventLogService';
import { EventType } from '../src/types';
import {
  APPLY_CONSULTANT_PHRASE,
  handleApplyConsultant,
} from '../src/services/consultantApplicationService';
import { handleConsultantManagementCommand } from '../src/services/consultantManagementService';
import { handleMyServiceGroups, MY_SERVICE_GROUPS_PHRASE } from '../src/services/consultantServiceGroupsService';
import { handleBotLeaveGroup } from '../src/services/botLeaveGroupService';
import { maybeSendServicePeriodEndedMessage } from '../src/services/servicePeriodEndMessageService';
import { buildConsultantDisableFallbackMessage, buildServicePeriodEndedMessage } from '../src/services/fixedMessageTemplates';
import {
  approveConsultant,
  getConsultant,
  registerAdmin,
  requestConsultantJoin,
  registerInviteCode,
} from '../src/services/consultantWhitelist';
import { handleServiceIntroduction } from '../src/services/servicePeriodService';
import { ensureGroupAssignment } from '../src/services/groupConsultantAssignmentService';
import { updateGroupFlags } from '../src/services/groupFlags';
import { createPendingHandoff } from '../src/services/pendingHandoffService';
import { createIssueThread } from '../src/services/issueThreadService';
import { handleDmSessionPrivateMessage } from '../src/services/dmSessionService';
import { handleKnowledgeCardCommand } from '../src/services/knowledgeCardCommandService';
import { handleDisabledConsultantGroupCommand } from '../src/services/disabledConsultantGroupService';
import { GROUP_ASSISTANT_COMMANDS } from '../src/services/groupAssistantCommandService';
import { loadEnv, resetEnvCache } from '../src/config/env';
import {
  resetTestState,
  TEST_ADMIN,
  TEST_CONSULTANT,
  TEST_CUSTOMER,
  TEST_GROUP,
} from './helpers/testSetup';

async function seedAdmin(): Promise<void> {
  await registerAdmin(TEST_ADMIN, 'Admin');
}

async function seedActiveConsultant(code = 'C-test-01'): Promise<void> {
  await seedAdmin();
  await registerInviteCode('JOIN1', TEST_ADMIN);
  await requestConsultantJoin(TEST_CONSULTANT, 'JOIN1', '王小明');
  const pending = await getRepos().consultantApplications.findPendingByUserId(TEST_CONSULTANT);
  if (pending) {
    await getRepos().consultantApplications.approve({
      applicationCode: pending.applicationCode,
      resolvedBy: TEST_ADMIN,
      resolvedAt: new Date().toISOString(),
    });
    await getRepos().consultants.upsertApprovedConsultant({
      userId: TEST_CONSULTANT,
      displayName: '王小明',
      consultantCode: code,
      approvedBy: TEST_ADMIN,
      approvedAt: new Date().toISOString(),
    });
  } else {
    await approveConsultant(TEST_ADMIN, TEST_CONSULTANT);
    await getRepos().consultants.upsertApprovedConsultant({
      userId: TEST_CONSULTANT,
      displayName: '王小明',
      consultantCode: code,
      approvedBy: TEST_ADMIN,
      approvedAt: new Date().toISOString(),
    });
  }
}

describe('consultant management batch 1', () => {
  beforeEach(async () => {
    await resetTestState();
    await seedAdmin();
  });

  describe('application flow', () => {
    it('creates pending application and notifies admin', async () => {
      const result = await processMessage({
        userId: 'U-applicant',
        text: APPLY_CONSULTANT_PHRASE,
        isGroup: false,
      });
      const pending = await getRepos().consultantApplications.listPending();
      expect(pending).toHaveLength(1);
      expect(result.replies.some((r) => r.userId === TEST_ADMIN)).toBe(true);
    });

    it('approves application and activates consultant', async () => {
      await handleApplyConsultant({ userId: 'U-applicant', displayName: '申請者' });
      const pending = await getRepos().consultantApplications.listPending();
      const replies = await handleConsultantManagementCommand(
        TEST_ADMIN,
        `核准 ${pending[0].applicationCode}`
      );
      expect(replies?.some((r) => r.text?.includes('已核准'))).toBe(true);
      const consultant = await getConsultant('U-applicant');
      expect(consultant?.status).toBe('active');
    });

    it('rejects application and allows re-apply', async () => {
      await handleApplyConsultant({ userId: 'U-applicant' });
      const pending = await getRepos().consultantApplications.listPending();
      await handleConsultantManagementCommand(TEST_ADMIN, `拒絕 ${pending[0].applicationCode}`);
      await handleApplyConsultant({ userId: 'U-applicant' });
      const allPending = await getRepos().consultantApplications.listPending();
      expect(allPending.length).toBeGreaterThanOrEqual(1);
    });

    it('blocks active consultant from re-applying', async () => {
      await seedActiveConsultant();
      const result = await processMessage({
        userId: TEST_CONSULTANT,
        text: APPLY_CONSULTANT_PHRASE,
        isGroup: false,
      });
      expect(result.replies[0].text).toContain('已經是顧問身份');
    });

    it('blocks active admin from applying', async () => {
      const result = await processMessage({
        userId: TEST_ADMIN,
        text: APPLY_CONSULTANT_PHRASE,
        isGroup: false,
      });
      expect(result.replies[0].text).toContain('管理者身份');
    });
  });

  describe('management commands', () => {
    beforeEach(async () => {
      await seedActiveConsultant('C-20260610-01');
    });

    it('lists consultants', async () => {
      const replies = await handleConsultantManagementCommand(TEST_ADMIN, '顧問名單');
      expect(replies?.[0].text).toContain('C-20260610-01');
      expect(replies?.[0].text).toContain('王小明');
    });

    it('lists pending applications', async () => {
      await handleApplyConsultant({ userId: 'U-pending' });
      const replies = await handleConsultantManagementCommand(TEST_ADMIN, '查詢待審顧問');
      expect(replies?.[0].text).toContain('U-pending');
    });

    it('disables consultant and cancels active dm session', async () => {
      await getRepos().dmSessions.create({
        sessionId: 'sess-1',
        userId: TEST_CONSULTANT,
        sessionType: 'knowledge_draft',
        draftData: { draftText: 'draft', humanReadableDraft: 'draft' },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      const thread = await createIssueThread(TEST_GROUP, 'Q');
      await createPendingHandoff({
        consultantId: TEST_CONSULTANT,
        issueThreadId: thread.issueThreadId,
        groupId: TEST_GROUP,
        shortCode: 'Q-test-01',
        customerQuestion: 'Q',
      });
      await handleServiceIntroduction(TEST_GROUP, TEST_ADMIN);
      const replies = await handleConsultantManagementCommand(
        TEST_ADMIN,
        '停用 C-20260610-01'
      );
      expect(replies?.[0].text).toContain('已停用顧問');
      expect(replies?.[0].text).toContain('取消整理中草稿');
      const consultant = await getConsultant(TEST_CONSULTANT);
      expect(consultant?.status).toBe('disabled');
    });

    it('re-enables consultant', async () => {
      await handleConsultantManagementCommand(TEST_ADMIN, '停用 C-20260610-01');
      const replies = await handleConsultantManagementCommand(TEST_ADMIN, '啟用 C-20260610-01');
      expect(replies?.some((r) => r.userId === TEST_CONSULTANT)).toBe(true);
    });

    it('blocks disabling last active admin', async () => {
      const replies = await handleConsultantManagementCommand(TEST_ADMIN, `停用 ${TEST_ADMIN}`);
      expect(replies?.[0].text).toContain('不可停用最後一位管理者');
    });
  });

  describe('disabled consultant permissions', () => {
    beforeEach(async () => {
      await seedActiveConsultant('C-disabled-01');
      await handleConsultantManagementCommand(TEST_ADMIN, '停用 C-disabled-01');
    });

    it('blocks knowledge card command', async () => {
      const replies = await handleKnowledgeCardCommand({
        userId: TEST_CONSULTANT,
        text: '列出所有知識卡',
      });
      expect(replies?.[0].text).toContain('不可查看知識庫');
    });

    it('blocks dm draft', async () => {
      const replies = await handleDmSessionPrivateMessage({
        userId: TEST_CONSULTANT,
        text: '幫我整理知識卡',
      });
      expect(replies?.[0].text).toContain('無權限');
    });

    it('treats disabled consultant group speech without assistant takeover', async () => {
      await handleServiceIntroduction(TEST_GROUP, TEST_ADMIN);
      const result = await processMessage({
        userId: TEST_CONSULTANT,
        groupId: TEST_GROUP,
        text: '👍',
        isGroup: true,
      });
      expect(result.replies).toHaveLength(0);
    });

    it('rejects disabled consultant assistant command with admin notify', async () => {
      const replies = await handleDisabledConsultantGroupCommand({
        userId: TEST_CONSULTANT,
        groupId: TEST_GROUP,
        text: GROUP_ASSISTANT_COMMANDS.MUTE,
      });
      expect(replies?.some((r) => r.userId === TEST_ADMIN)).toBe(true);
    });
  });

  describe('my service groups', () => {
    it('lists in-service related groups for active consultant', async () => {
      await seedActiveConsultant('C-svc-01');
      await handleServiceIntroduction(TEST_GROUP, TEST_ADMIN);
      await ensureGroupAssignment(TEST_GROUP);
      await getRepos().groupConsultantAssignments.update(TEST_GROUP, {
        primaryConsultantUserId: TEST_CONSULTANT,
      });
      const replies = await handleMyServiceGroups(TEST_CONSULTANT);
      expect(replies?.[0].text).toContain('G-01');
      expect(replies?.[0].text).toContain('主負責');
    });

    it('rejects disabled consultant', async () => {
      await seedActiveConsultant('C-svc-02');
      await handleConsultantManagementCommand(TEST_ADMIN, '停用 C-svc-02');
      const replies = await handleMyServiceGroups(TEST_CONSULTANT);
      expect(replies?.[0].text).toContain('已被停用');
    });
  });

  describe('bot leave and service period end', () => {
    it('maps leave event and notifies admin', async () => {
      await getRepos().groups.update(TEST_GROUP, { groupName: 'XX美甲店' });
      const mapped = mapLeaveEvent({
        type: 'leave',
        source: { type: 'group', groupId: TEST_GROUP },
      });
      expect(mapped?.groupId).toBe(TEST_GROUP);
      const replies = await handleBotLeaveGroup(TEST_GROUP);
      expect(replies.some((r) => r.userId === TEST_ADMIN)).toBe(true);
      const flags = await getRepos().groups.getOrCreate(TEST_GROUP);
      expect(flags.botLeftAt).not.toBeNull();
    });

    it('sends service period ended message once', async () => {
      resetEnvCache();
      loadEnv({ OFFICIAL_LINE_URL: 'https://line.me/example' });
      const end = new Date(Date.now() - 86400000).toISOString();
      const start = new Date(Date.now() - 31 * 86400000).toISOString();
      await updateGroupFlags(TEST_GROUP, {
        serviceStartAt: start,
        serviceEndAt: end,
        servicePeriodEndNotified: false,
      });
      const first = await maybeSendServicePeriodEndedMessage(TEST_GROUP);
      expect(first[0].text).toContain('30 天教學協助期已結束');
      expect(first[0].text).toContain('https://line.me/example');
      const second = await maybeSendServicePeriodEndedMessage(TEST_GROUP);
      expect(second).toHaveLength(0);
    });

    it('works without OFFICIAL_LINE_URL', () => {
      resetEnvCache();
      loadEnv({ OFFICIAL_LINE_URL: null });
      const text = buildServicePeriodEndedMessage();
      expect(text).not.toContain('👉');
      expect(buildConsultantDisableFallbackMessage()).not.toContain('👉');
    });
  });

  describe('event logs', () => {
    it('records consultant_application_submitted', async () => {
      await handleApplyConsultant({ userId: 'U-log', displayName: 'Log' });
      const events = await getEventsByType(EventType.CONSULTANT_OVERRIDE);
      expect(events.some((e) => e.detail?.includes('consultant_application_submitted'))).toBe(true);
    });
  });
});
