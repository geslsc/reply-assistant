import { processMessage } from '../src/handlers/lineWebhookHandler';
import { mapJoinEvent } from '../src/routes/lineWebhook';
import { getRepos } from '../src/repositories';
import { getEventsByType } from '../src/services/eventLogService';
import { EventType, RiskLevel, ThreadState } from '../src/types';
import { handleGroupAdminCommand, GROUP_LIST_PHRASE } from '../src/services/groupConsultantAdminService';
import {
  ensureGroupAssignment,
  handleGroupConsultantSideEffects,
} from '../src/services/groupConsultantAssignmentService';
import { handleMyServiceGroups, MY_SERVICE_GROUPS_PHRASE } from '../src/services/consultantServiceGroupsService';
import { handleBotJoinGroup } from '../src/services/botJoinGroupService';
import { executeHandoff } from '../src/services/consultantHandoffService';
import { resolveHandoffTarget } from '../src/services/handoffRoutingService';
import { handleConsultantManagementCommand } from '../src/services/consultantManagementService';
import { GROUP_ASSISTANT_COMMANDS } from '../src/services/groupAssistantCommandService';
import { handleDisabledConsultantGroupCommand } from '../src/services/disabledConsultantGroupService';
import { handleServiceIntroduction } from '../src/services/servicePeriodService';
import { createIssueThread } from '../src/services/issueThreadService';
import { createPendingHandoff } from '../src/services/pendingHandoffService';
import { setLineGroupSummaryClient } from '../src/services/lineGroupSummaryService';
import {
  registerAdmin,
  registerInviteCode,
  requestConsultantJoin,
} from '../src/services/consultantWhitelist';
import { validateKnowledgeCard } from '../src/services/knowledgeCardValidator';
import { loadEnv, resetEnvCache } from '../src/config/env';
import {
  resetTestState,
  TEST_ADMIN,
  TEST_CONSULTANT,
  TEST_CUSTOMER,
  TEST_GROUP,
  TEST_GROUP_B,
} from './helpers/testSetup';

const TEST_CONSULTANT_B = 'consultant-002';

async function seedAdmin(): Promise<void> {
  await registerAdmin(TEST_ADMIN, 'Admin');
}

async function seedActiveConsultant(
  userId: string,
  displayName: string,
  codeSuffix: string
): Promise<string> {
  await seedAdmin();
  await registerInviteCode(`JOIN-${codeSuffix}`, TEST_ADMIN);
  await requestConsultantJoin(userId, `JOIN-${codeSuffix}`, displayName);
  const pending = await getRepos().consultantApplications.findPendingByUserId(userId);
  if (pending) {
    await getRepos().consultantApplications.approve({
      applicationCode: pending.applicationCode,
      resolvedBy: TEST_ADMIN,
      resolvedAt: new Date().toISOString(),
    });
    await getRepos().consultants.upsertApprovedConsultant({
      userId,
      displayName,
      consultantCode: pending.applicationCode,
      approvedBy: TEST_ADMIN,
      approvedAt: new Date().toISOString(),
    });
    return pending.applicationCode;
  }
  return `C-${codeSuffix}`;
}

async function getGroupCode(groupId: string): Promise<string> {
  const assignment = await ensureGroupAssignment(groupId);
  return assignment.groupCode;
}

function findManagementEvent(action: string) {
  return getEventsByType(EventType.CONSULTANT_OVERRIDE).then((events) =>
    events.find((e) => e.detail?.includes(`"action":"${action}"`) || e.detail?.includes(action))
  );
}

describe('consultant management batch 2', () => {
  beforeEach(async () => {
    await resetTestState();
    await seedAdmin();
  });

  describe('auto bind', () => {
    it('binds active consultant on assistant intro and notifies admin', async () => {
      const code = await seedActiveConsultant(TEST_CONSULTANT, '王小明', '01');
      await handleServiceIntroduction(TEST_GROUP, TEST_ADMIN);
      const groupCode = await getGroupCode(TEST_GROUP);

      const replies = await handleGroupConsultantSideEffects({
        groupId: TEST_GROUP,
        userId: TEST_CONSULTANT,
        text: GROUP_ASSISTANT_COMMANDS.INTRO,
      });

      const assignment = await getRepos().groupConsultantAssignments.findByGroupId(TEST_GROUP);
      expect(assignment?.primaryConsultantUserId).toBe(TEST_CONSULTANT);
      expect(replies.some((r) => r.userId === TEST_ADMIN)).toBe(true);
      expect(replies.some((r) => r.text.includes(groupCode))).toBe(true);
      expect(replies.some((r) => r.text.includes(code))).toBe(true);

      const event = await findManagementEvent('auto_bind_primary');
      expect(event).toBeDefined();
    });

    it('binds active admin on assistant intro and notifies self', async () => {
      await handleServiceIntroduction(TEST_GROUP, TEST_ADMIN);
      const groupCode = await getGroupCode(TEST_GROUP);

      const replies = await handleGroupConsultantSideEffects({
        groupId: TEST_GROUP,
        userId: TEST_ADMIN,
        text: GROUP_ASSISTANT_COMMANDS.INTRO,
      });

      const assignment = await getRepos().groupConsultantAssignments.findByGroupId(TEST_GROUP);
      expect(assignment?.primaryConsultantUserId).toBe(TEST_ADMIN);
      expect(replies.some((r) => r.userId === TEST_ADMIN && r.text.includes('已將您自動綁定'))).toBe(
        true
      );
      expect(replies.some((r) => r.text.includes(groupCode))).toBe(true);
    });

    it('does not bind on general consultant speech', async () => {
      await seedActiveConsultant(TEST_CONSULTANT, '王小明', '02');
      await ensureGroupAssignment(TEST_GROUP);
      await handleGroupConsultantSideEffects({
        groupId: TEST_GROUP,
        userId: TEST_CONSULTANT,
        text: '這題我來回',
      });
      const assignment = await getRepos().groupConsultantAssignments.findByGroupId(TEST_GROUP);
      expect(assignment?.primaryConsultantUserId ?? null).toBeNull();
    });

    it('detects second consultant without overwriting primary', async () => {
      const codeA = await seedActiveConsultant(TEST_CONSULTANT, '顧問A', '03');
      const codeB = await seedActiveConsultant(TEST_CONSULTANT_B, '顧問B', '04');
      await handleServiceIntroduction(TEST_GROUP, TEST_ADMIN);
      await getRepos().groupConsultantAssignments.update(TEST_GROUP, {
        primaryConsultantUserId: TEST_CONSULTANT,
      });

      const replies = await handleGroupConsultantSideEffects({
        groupId: TEST_GROUP,
        userId: TEST_CONSULTANT_B,
        text: GROUP_ASSISTANT_COMMANDS.MUTE,
      });

      const assignment = await getRepos().groupConsultantAssignments.findByGroupId(TEST_GROUP);
      expect(assignment?.primaryConsultantUserId).toBe(TEST_CONSULTANT);
      expect(replies.some((r) => r.userId === TEST_ADMIN)).toBe(true);
      expect(replies.some((r) => r.text.includes(codeA))).toBe(true);
      expect(replies.some((r) => r.text.includes(codeB))).toBe(true);

      const event = await findManagementEvent('second_consultant_detected');
      expect(event).toBeDefined();
    });

    it('blocks disabled consultant assistant command via batch 1 guard', async () => {
      await seedActiveConsultant(TEST_CONSULTANT, '停用測', '05');
      await handleConsultantManagementCommand(TEST_ADMIN, `停用 ${TEST_CONSULTANT}`);
      await handleServiceIntroduction(TEST_GROUP, TEST_ADMIN);

      const replies = await handleDisabledConsultantGroupCommand({
        userId: TEST_CONSULTANT,
        groupId: TEST_GROUP,
        text: GROUP_ASSISTANT_COMMANDS.INTRO,
      });
      expect(replies?.some((r) => r.userId === TEST_ADMIN)).toBe(true);
      const assignment = await getRepos().groupConsultantAssignments.findByGroupId(TEST_GROUP);
      expect(assignment?.primaryConsultantUserId ?? null).toBeNull();
    });
  });

  describe('admin assign', () => {
    beforeEach(async () => {
      await handleServiceIntroduction(TEST_GROUP, TEST_ADMIN);
    });

    it('assigns primary by group code', async () => {
      const code = await seedActiveConsultant(TEST_CONSULTANT, '王小明', '10');
      const groupCode = await getGroupCode(TEST_GROUP);
      const replies = await handleGroupAdminCommand(
        TEST_ADMIN,
        `設定群組 ${groupCode} 主負責 ${code}`
      );
      expect(replies?.[0].text).toContain('已設定');
      const assignment = await getRepos().groupConsultantAssignments.findByGroupId(TEST_GROUP);
      expect(assignment?.primaryConsultantUserId).toBe(TEST_CONSULTANT);
    });

    it('assigns primary and secondary', async () => {
      const codeA = await seedActiveConsultant(TEST_CONSULTANT, 'A', '11');
      const codeB = await seedActiveConsultant(TEST_CONSULTANT_B, 'B', '12');
      const groupCode = await getGroupCode(TEST_GROUP);
      await handleGroupAdminCommand(
        TEST_ADMIN,
        `設定群組 ${groupCode} 主負責 ${codeA} 副手 ${codeB}`
      );
      const assignment = await getRepos().groupConsultantAssignments.findByGroupId(TEST_GROUP);
      expect(assignment?.primaryConsultantUserId).toBe(TEST_CONSULTANT);
      expect(assignment?.secondaryConsultantUserId).toBe(TEST_CONSULTANT_B);
    });

    it('allows admin to assign self as primary', async () => {
      const groupCode = await getGroupCode(TEST_GROUP);
      await handleGroupAdminCommand(TEST_ADMIN, `設定群組 ${groupCode} 主負責 ${TEST_ADMIN}`);
      const assignment = await getRepos().groupConsultantAssignments.findByGroupId(TEST_GROUP);
      expect(assignment?.primaryConsultantUserId).toBe(TEST_ADMIN);
    });

    it('rejects primary equals secondary', async () => {
      const code = await seedActiveConsultant(TEST_CONSULTANT, 'Same', '13');
      const groupCode = await getGroupCode(TEST_GROUP);
      const replies = await handleGroupAdminCommand(
        TEST_ADMIN,
        `設定群組 ${groupCode} 主負責 ${code} 副手 ${code}`
      );
      expect(replies?.[0].text).toContain('不可等於');
    });

    it('rejects disabled consultant assignment', async () => {
      const code = await seedActiveConsultant(TEST_CONSULTANT, 'Dis', '14');
      await handleConsultantManagementCommand(TEST_ADMIN, `停用 ${code}`);
      const groupCode = await getGroupCode(TEST_GROUP);
      const replies = await handleGroupAdminCommand(
        TEST_ADMIN,
        `設定群組 ${groupCode} 主負責 ${code}`
      );
      expect(replies?.[0].text).toContain('active');
    });

    it('rejects unknown consultant code', async () => {
      const groupCode = await getGroupCode(TEST_GROUP);
      const replies = await handleGroupAdminCommand(
        TEST_ADMIN,
        `設定群組 ${groupCode} 主負責 C-NOPE-99`
      );
      expect(replies?.[0].text).toContain('找不到');
    });

    it('unassigns group consultants', async () => {
      const code = await seedActiveConsultant(TEST_CONSULTANT, 'U', '15');
      const groupCode = await getGroupCode(TEST_GROUP);
      await handleGroupAdminCommand(TEST_ADMIN, `設定群組 ${groupCode} 主負責 ${code}`);
      await handleGroupAdminCommand(TEST_ADMIN, `解除群組 ${groupCode} 負責人`);
      const assignment = await getRepos().groupConsultantAssignments.findByGroupId(TEST_GROUP);
      expect(assignment?.primaryConsultantUserId).toBeNull();
      expect(assignment?.secondaryConsultantUserId).toBeNull();
    });
  });

  describe('group list queries', () => {
    it('lists all groups for admin', async () => {
      await handleServiceIntroduction(TEST_GROUP, TEST_ADMIN);
      await handleServiceIntroduction(TEST_GROUP_B, TEST_ADMIN);
      const replies = await handleGroupAdminCommand(TEST_ADMIN, GROUP_LIST_PHRASE);
      expect(replies?.[0].text).toContain('G-01');
      expect(replies?.[0].text).toContain('G-02');
    });

    it('shows group status by code with operation hints', async () => {
      await handleServiceIntroduction(TEST_GROUP, TEST_ADMIN);
      const groupCode = await getGroupCode(TEST_GROUP);
      const replies = await handleGroupAdminCommand(TEST_ADMIN, `群組 ${groupCode} 狀態`);
      expect(replies?.[0].text).toContain(groupCode);
      expect(replies?.[0].text).toContain('可用操作');
    });

    it('returns candidates when group name is duplicated', async () => {
      await getRepos().groupConsultantAssignments.create({
        groupId: TEST_GROUP,
        groupCode: 'G-01',
        groupName: 'XX美甲店',
        updatedBy: 'system',
      });
      await getRepos().groupConsultantAssignments.create({
        groupId: TEST_GROUP_B,
        groupCode: 'G-02',
        groupName: 'XX美甲店',
        updatedBy: 'system',
      });
      const replies = await handleGroupAdminCommand(TEST_ADMIN, 'XX美甲店 狀態');
      expect(replies?.[0].text).toContain('G-01');
      expect(replies?.[0].text).toContain('G-02');
      expect(replies?.[0].text).toContain('group_code');
    });

    it('lists admin own service groups', async () => {
      await handleServiceIntroduction(TEST_GROUP, TEST_ADMIN);
      const groupCode = await getGroupCode(TEST_GROUP);
      await getRepos().groupConsultantAssignments.update(TEST_GROUP, {
        primaryConsultantUserId: TEST_ADMIN,
      });
      const replies = await handleMyServiceGroups(TEST_ADMIN);
      expect(replies?.[0].text).toContain(groupCode);
      expect(replies?.[0].text).toContain('主負責');
    });

    it('lists consultant own service groups only', async () => {
      const code = await seedActiveConsultant(TEST_CONSULTANT, 'Own', '20');
      await handleServiceIntroduction(TEST_GROUP, TEST_ADMIN);
      const groupCode = await getGroupCode(TEST_GROUP);
      await getRepos().groupConsultantAssignments.update(TEST_GROUP, {
        primaryConsultantUserId: TEST_CONSULTANT,
      });
      const replies = await handleMyServiceGroups(TEST_CONSULTANT);
      expect(replies?.[0].text).toContain(groupCode);
      expect(replies?.[0].text).toContain('主負責');
    });

    it('rejects consultant group list command', async () => {
      await seedActiveConsultant(TEST_CONSULTANT, 'C', '21');
      const replies = await processMessage({
        userId: TEST_CONSULTANT,
        text: GROUP_LIST_PHRASE,
        isGroup: false,
      });
      expect(replies.replies[0].text).toContain('僅 active admin');
    });

    it('rejects disabled consultant my service groups', async () => {
      const code = await seedActiveConsultant(TEST_CONSULTANT, 'D', '22');
      await handleConsultantManagementCommand(TEST_ADMIN, `停用 ${code}`);
      const replies = await handleMyServiceGroups(TEST_CONSULTANT);
      expect(replies?.[0].text).toContain('已被停用');
    });
  });

  describe('handoff routing', () => {
    it('routes to active primary consultant', async () => {
      await seedActiveConsultant(TEST_CONSULTANT, 'P', '30');
      await handleServiceIntroduction(TEST_GROUP, TEST_ADMIN);
      await getRepos().groupConsultantAssignments.update(TEST_GROUP, {
        primaryConsultantUserId: TEST_CONSULTANT,
      });
      const target = await resolveHandoffTarget(TEST_GROUP);
      expect(target?.userId).toBe(TEST_CONSULTANT);
      expect(target?.targetRole).toBe('primary');
    });

    it('routes to admin primary without fallback path', async () => {
      await handleServiceIntroduction(TEST_GROUP, TEST_ADMIN);
      await getRepos().groupConsultantAssignments.update(TEST_GROUP, {
        primaryConsultantUserId: TEST_ADMIN,
      });
      const target = await resolveHandoffTarget(TEST_GROUP);
      expect(target?.userId).toBe(TEST_ADMIN);
      expect(target?.targetRole).toBe('primary');
    });

    it('routes to secondary when primary inactive', async () => {
      const codeP = await seedActiveConsultant(TEST_CONSULTANT, 'P', '31');
      const codeS = await seedActiveConsultant(TEST_CONSULTANT_B, 'S', '32');
      await handleServiceIntroduction(TEST_GROUP, TEST_ADMIN);
      await getRepos().groupConsultantAssignments.update(TEST_GROUP, {
        primaryConsultantUserId: TEST_CONSULTANT,
        secondaryConsultantUserId: TEST_CONSULTANT_B,
      });
      await handleConsultantManagementCommand(TEST_ADMIN, `停用 ${codeP}`);
      const target = await resolveHandoffTarget(TEST_GROUP);
      expect(target?.userId).toBe(TEST_CONSULTANT_B);
      expect(target?.targetRole).toBe('secondary');
    });

    it('routes to fallback admin when no active assignee', async () => {
      await handleServiceIntroduction(TEST_GROUP, TEST_ADMIN);
      const target = await resolveHandoffTarget(TEST_GROUP);
      expect(target?.userId).toBe(TEST_ADMIN);
      expect(target?.targetRole).toBe('fallback_admin');
    });

    it('creates pending_handoff only for routed recipient', async () => {
      await seedActiveConsultant(TEST_CONSULTANT, 'H', '33');
      await seedActiveConsultant(TEST_CONSULTANT_B, 'Other', '34');
      await handleServiceIntroduction(TEST_GROUP, TEST_ADMIN);
      await getRepos().groupConsultantAssignments.update(TEST_GROUP, {
        primaryConsultantUserId: TEST_CONSULTANT,
      });
      const thread = await createIssueThread(TEST_GROUP, '問題');
      await executeHandoff({
        groupId: TEST_GROUP,
        issueThreadId: thread.issueThreadId,
        customerQuestion: '問題',
        card: null,
        reason: 'test',
        riskLevel: RiskLevel.UNKNOWN,
      });
      const primaryOpen = await getRepos().pendingHandoffs.findOpenByConsultant(TEST_CONSULTANT);
      const otherOpen = await getRepos().pendingHandoffs.findOpenByConsultant(TEST_CONSULTANT_B);
      expect(primaryOpen).toHaveLength(1);
      expect(otherOpen).toHaveLength(0);

      const event = await findManagementEvent('handoff_routed');
      expect(event?.detail).toContain('primary');
    });
  });

  describe('disable handoff transfer', () => {
    it('transfers open handoffs to secondary on disable', async () => {
      const codeP = await seedActiveConsultant(TEST_CONSULTANT, 'P', '40');
      await seedActiveConsultant(TEST_CONSULTANT_B, 'S', '41');
      await handleServiceIntroduction(TEST_GROUP, TEST_ADMIN);
      await getRepos().groupConsultantAssignments.update(TEST_GROUP, {
        primaryConsultantUserId: TEST_CONSULTANT,
        secondaryConsultantUserId: TEST_CONSULTANT_B,
      });
      const thread = await createIssueThread(TEST_GROUP, '轉移題');
      await createPendingHandoff({
        consultantId: TEST_CONSULTANT,
        issueThreadId: thread.issueThreadId,
        groupId: TEST_GROUP,
        shortCode: 'Q-transfer-01',
        customerQuestion: '轉移題',
      });
      await handleConsultantManagementCommand(TEST_ADMIN, `停用 ${codeP}`);
      const secondaryOpen = await getRepos().pendingHandoffs.findOpenByConsultant(TEST_CONSULTANT_B);
      expect(secondaryOpen).toHaveLength(1);
      const event = await findManagementEvent('handoff_transferred_on_disable');
      expect(event?.detail).toContain('secondary');
    });

    it('transfers to fallback admin when no secondary', async () => {
      const codeP = await seedActiveConsultant(TEST_CONSULTANT, 'P', '42');
      await handleServiceIntroduction(TEST_GROUP, TEST_ADMIN);
      await getRepos().groupConsultantAssignments.update(TEST_GROUP, {
        primaryConsultantUserId: TEST_CONSULTANT,
      });
      const thread = await createIssueThread(TEST_GROUP, '轉移題2');
      await createPendingHandoff({
        consultantId: TEST_CONSULTANT,
        issueThreadId: thread.issueThreadId,
        groupId: TEST_GROUP,
        shortCode: 'Q-transfer-02',
        customerQuestion: '轉移題2',
      });
      await handleConsultantManagementCommand(TEST_ADMIN, `停用 ${codeP}`);
      const adminOpen = await getRepos().pendingHandoffs.findOpenByConsultant(TEST_ADMIN);
      expect(adminOpen).toHaveLength(1);
    });

    it('does not transfer closed handoffs', async () => {
      const codeP = await seedActiveConsultant(TEST_CONSULTANT, 'P', '43');
      await seedActiveConsultant(TEST_CONSULTANT_B, 'S', '44');
      await handleServiceIntroduction(TEST_GROUP, TEST_ADMIN);
      await getRepos().groupConsultantAssignments.update(TEST_GROUP, {
        primaryConsultantUserId: TEST_CONSULTANT,
        secondaryConsultantUserId: TEST_CONSULTANT_B,
      });
      const thread = await createIssueThread(TEST_GROUP, '已關');
      const handoff = await createPendingHandoff({
        consultantId: TEST_CONSULTANT,
        issueThreadId: thread.issueThreadId,
        groupId: TEST_GROUP,
        shortCode: 'Q-closed',
        customerQuestion: '已關',
      });
      await getRepos().pendingHandoffs.markClosed(handoff.id);
      await handleConsultantManagementCommand(TEST_ADMIN, `停用 ${codeP}`);
      const secondaryOpen = await getRepos().pendingHandoffs.findOpenByConsultant(TEST_CONSULTANT_B);
      expect(secondaryOpen).toHaveLength(0);
    });
  });

  describe('new group detection', () => {
    it('creates assignment on bot join', async () => {
      const mapped = mapJoinEvent({
        type: 'join',
        source: { type: 'group', groupId: TEST_GROUP },
      });
      expect(mapped?.groupId).toBe(TEST_GROUP);
      await handleBotJoinGroup(TEST_GROUP);
      const assignment = await getRepos().groupConsultantAssignments.findByGroupId(TEST_GROUP);
      expect(assignment?.groupCode).toBe('G-01');
      expect(assignment?.primaryConsultantUserId).toBeNull();
      expect(assignment?.secondaryConsultantUserId).toBeNull();
    });

    it('creates assignment on first group message', async () => {
      await processMessage({
        userId: TEST_CUSTOMER,
        groupId: TEST_GROUP,
        text: '請問怎麼用',
        isGroup: true,
      });
      const assignment = await getRepos().groupConsultantAssignments.findByGroupId(TEST_GROUP);
      expect(assignment?.groupCode).toMatch(/^G-/);
    });

    it('does not duplicate assignment for same group_id', async () => {
      await ensureGroupAssignment(TEST_GROUP);
      await ensureGroupAssignment(TEST_GROUP);
      const all = await getRepos().groupConsultantAssignments.listAll();
      expect(all.filter((a) => a.groupId === TEST_GROUP)).toHaveLength(1);
    });

    it('uses groupId label when LINE summary fails', async () => {
      setLineGroupSummaryClient({
        getGroupSummary: jest.fn(async () => null),
      });
      const assignment = await ensureGroupAssignment(TEST_GROUP);
      expect(assignment.groupName).toBeNull();
      const event = await findManagementEvent('new_group_detected');
      expect(event).toBeDefined();
    });

    it('records new_group_detected event', async () => {
      await ensureGroupAssignment(TEST_GROUP_B);
      const event = await findManagementEvent('new_group_detected');
      expect(event?.detail).toContain(TEST_GROUP_B);
    });
  });

  describe('timestamp fields', () => {
    it('updates last_consultant_action_at on assistant command', async () => {
      await seedActiveConsultant(TEST_CONSULTANT, 'T', '50');
      await handleServiceIntroduction(TEST_GROUP, TEST_ADMIN);
      await handleGroupConsultantSideEffects({
        groupId: TEST_GROUP,
        userId: TEST_CONSULTANT,
        text: GROUP_ASSISTANT_COMMANDS.UNMUTE,
      });
      const assignment = await getRepos().groupConsultantAssignments.findByGroupId(TEST_GROUP);
      expect(assignment?.lastConsultantActionAt).not.toBeNull();
    });

    it('updates last_customer_message_at on customer message', async () => {
      await handleServiceIntroduction(TEST_GROUP, TEST_ADMIN);
      await processMessage({
        userId: TEST_CUSTOMER,
        groupId: TEST_GROUP,
        text: '請問',
        isGroup: true,
      });
      const assignment = await getRepos().groupConsultantAssignments.findByGroupId(TEST_GROUP);
      expect(assignment?.lastCustomerMessageAt).not.toBeNull();
    });

    it('does not bind on consultant general speech', async () => {
      await seedActiveConsultant(TEST_CONSULTANT, 'G', '51');
      await handleServiceIntroduction(TEST_GROUP, TEST_ADMIN);
      await processMessage({
        userId: TEST_CONSULTANT,
        groupId: TEST_GROUP,
        text: '我來回答這題',
        isGroup: true,
      });
      const assignment = await getRepos().groupConsultantAssignments.findByGroupId(TEST_GROUP);
      expect(assignment?.primaryConsultantUserId).toBeNull();
    });
  });

  describe('red line regression', () => {
    it('ThreadState count remains 5', () => {
      expect(Object.keys(ThreadState).length).toBe(5);
    });

    it('EventType count remains 10', () => {
      expect(Object.keys(EventType).length).toBe(10);
    });

    it('validateKnowledgeCard remains final gate', () => {
      const result = validateKnowledgeCard({
        card_id: 'test',
        title: '',
        patterns: [],
        risk_level: 'low',
        can_public_reply: true,
        standard_answer: 'x',
        status: 'active',
        created_by: 'u',
        created_at: new Date().toISOString(),
        confirmed_by: 'u',
        confirmed_at: new Date().toISOString(),
      });
      expect(result.valid).toBe(false);
    });

    it('OPENAI_API_KEY and OFFICIAL_LINE_URL remain optional', () => {
      resetEnvCache();
      const env = loadEnv({ OPENAI_API_KEY: null, OFFICIAL_LINE_URL: null });
      expect(env.OPENAI_API_KEY).toBeNull();
      expect(env.OFFICIAL_LINE_URL).toBeNull();
    });

    it('general speech does not trigger assistant in group', async () => {
      await seedActiveConsultant(TEST_CONSULTANT, 'R', '60');
      await handleServiceIntroduction(TEST_GROUP, TEST_ADMIN);
      const result = await processMessage({
        userId: TEST_CONSULTANT,
        groupId: TEST_GROUP,
        text: '一般回覆',
        isGroup: true,
      });
      expect(result.replies.filter((r) => r.type === 'group')).toHaveLength(0);
    });
  });
});
