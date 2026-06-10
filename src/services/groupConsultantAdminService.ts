import { BotReply } from '../types';
import { getRepos } from '../repositories';
import { GroupConsultantAssignmentRecord } from '../repositories/groupConsultantAssignmentTypes';
import { isActiveAdmin } from './consultantWhitelist';
import { logConsultantManagementEvent } from './consultantEventLogService';
import {
  formatAssignmentGroupLabel,
  formatConsultantAssignmentDisplay,
  resolveConsultantByCodeOrUserId,
  validateActiveAssignee,
} from './groupConsultantAssignmentService';

const ASSIGN_BOTH_PATTERN =
  /^設定群組\s+(G-\d+)\s+主負責\s+(\S+)\s+副手\s+(\S+)$/u;
const ASSIGN_PRIMARY_PATTERN = /^設定群組\s+(G-\d+)\s+主負責\s+(\S+)$/u;
const UNASSIGN_PATTERN = /^解除群組\s+(G-\d+)\s+負責人$/u;
const GROUP_CODE_STATUS_PATTERN = /^群組\s+(G-\d+)\s+狀態$/u;
const GROUP_NAME_STATUS_PATTERN = /^(.+)\s+狀態$/u;

export const GROUP_LIST_PHRASE = '群組清單';
const GROUP_LIST_PHRASES = new Set([
  GROUP_LIST_PHRASE,
  '查詢群組清單',
  '查詢群組列表',
  '群組列表',
  '列出群組',
  '列出群組列表',
]);

function isGroupListPhrase(text: string): boolean {
  return GROUP_LIST_PHRASES.has(text.trim());
}

function formatTimestamp(value: string | null): string {
  if (!value) {
    return '—';
  }
  return value.slice(0, 19).replace('T', ' ');
}

async function buildAssignmentDetailReply(
  adminUserId: string,
  assignment: GroupConsultantAssignmentRecord
): Promise<BotReply[]> {
  const primaryDisplay = await formatConsultantAssignmentDisplay(
    assignment.primaryConsultantUserId
  );
  const secondaryDisplay = await formatConsultantAssignmentDisplay(
    assignment.secondaryConsultantUserId
  );

  const lines = [
    `群組名稱：${formatAssignmentGroupLabel(assignment)}`,
    `group_id：${assignment.groupId}`,
    `group_code：${assignment.groupCode}`,
    `status：${assignment.status}`,
    `主負責：${primaryDisplay}`,
    `副手：${secondaryDisplay}`,
    `最近顧問操作：${formatTimestamp(assignment.lastConsultantActionAt)}`,
    `最近店家訊息：${formatTimestamp(assignment.lastCustomerMessageAt)}`,
    '',
    '可用操作：',
    `- 設定群組 ${assignment.groupCode} 主負責 C-01`,
    `- 設定群組 ${assignment.groupCode} 主負責 C-01 副手 C-02`,
    `- 解除群組 ${assignment.groupCode} 負責人`,
  ];

  return [{ type: 'push', userId: adminUserId, text: lines.join('\n') }];
}

export async function handleGroupAdminCommand(
  adminUserId: string,
  text: string
): Promise<BotReply[] | null> {
  if (!(await isActiveAdmin(adminUserId))) {
    return null;
  }

  const trimmed = text.trim();

  if (isGroupListPhrase(trimmed)) {
    return listAllGroups(adminUserId);
  }

  const bothMatch = trimmed.match(ASSIGN_BOTH_PATTERN);
  if (bothMatch) {
    return assignPrimaryAndSecondary(adminUserId, bothMatch[1], bothMatch[2], bothMatch[3]);
  }

  const primaryMatch = trimmed.match(ASSIGN_PRIMARY_PATTERN);
  if (primaryMatch) {
    return assignPrimaryOnly(adminUserId, primaryMatch[1], primaryMatch[2]);
  }

  const unassignMatch = trimmed.match(UNASSIGN_PATTERN);
  if (unassignMatch) {
    return unassignGroup(adminUserId, unassignMatch[1]);
  }

  const codeStatusMatch = trimmed.match(GROUP_CODE_STATUS_PATTERN);
  if (codeStatusMatch) {
    return showGroupStatusByCode(adminUserId, codeStatusMatch[1]);
  }

  const nameStatusMatch = trimmed.match(GROUP_NAME_STATUS_PATTERN);
  if (nameStatusMatch && !trimmed.startsWith('群組 G-')) {
    return showGroupStatusByName(adminUserId, nameStatusMatch[1]);
  }

  return null;
}

async function listAllGroups(adminUserId: string): Promise<BotReply[]> {
  const assignments = await getRepos().groupConsultantAssignments.listAll();
  if (assignments.length === 0) {
    return [{ type: 'push', userId: adminUserId, text: '目前沒有群組綁定資料。' }];
  }

  const blocks: string[] = ['【群組清單】'];
  for (const assignment of assignments) {
    const primaryDisplay = await formatConsultantAssignmentDisplay(
      assignment.primaryConsultantUserId
    );
    const secondaryDisplay = await formatConsultantAssignmentDisplay(
      assignment.secondaryConsultantUserId
    );
    blocks.push(
      [
        `群組：${formatAssignmentGroupLabel(assignment)}（${assignment.groupCode}）`,
        `status：${assignment.status}`,
        `主負責：${primaryDisplay}`,
        `副手：${secondaryDisplay}`,
        `最近顧問操作：${formatTimestamp(assignment.lastConsultantActionAt)}`,
        `最近店家訊息：${formatTimestamp(assignment.lastCustomerMessageAt)}`,
      ].join('\n')
    );
  }

  return [{ type: 'push', userId: adminUserId, text: blocks.join('\n\n') }];
}

async function showGroupStatusByCode(
  adminUserId: string,
  groupCode: string
): Promise<BotReply[]> {
  const assignment = await getRepos().groupConsultantAssignments.findByGroupCode(groupCode);
  if (!assignment) {
    return [{ type: 'push', userId: adminUserId, text: `找不到群組 ${groupCode}。` }];
  }
  return buildAssignmentDetailReply(adminUserId, assignment);
}

async function showGroupStatusByName(
  adminUserId: string,
  groupName: string
): Promise<BotReply[]> {
  const matches = await getRepos().groupConsultantAssignments.findByGroupName(groupName);
  if (matches.length === 0) {
    return [{ type: 'push', userId: adminUserId, text: `找不到名稱為「${groupName}」的群組。` }];
  }
  if (matches.length > 1) {
    const candidates = matches
      .map((item) => `${formatAssignmentGroupLabel(item)}（${item.groupCode}）`)
      .join('\n');
    return [
      {
        type: 'push',
        userId: adminUserId,
        text: `找到多筆同名群組，請改用 group_code 查詢：\n${candidates}`,
      },
    ];
  }
  return buildAssignmentDetailReply(adminUserId, matches[0]);
}

async function assignPrimaryOnly(
  adminUserId: string,
  groupCode: string,
  consultantCode: string
): Promise<BotReply[]> {
  const assignment = await getRepos().groupConsultantAssignments.findByGroupCode(groupCode);
  if (!assignment) {
    return [{ type: 'push', userId: adminUserId, text: `找不到群組 ${groupCode}。` }];
  }

  const consultant = await resolveConsultantByCodeOrUserId(consultantCode);
  const validation = await validateActiveAssignee(consultant);
  if (!validation.ok) {
    return [{ type: 'push', userId: adminUserId, text: validation.message ?? '無法指派。' }];
  }

  if (assignment.secondaryConsultantUserId === consultant!.userId) {
    return [
      {
        type: 'push',
        userId: adminUserId,
        text: '主負責不可與副手為同一人，請先調整副手或改用「主負責 + 副手」指令。',
      },
    ];
  }

  await getRepos().groupConsultantAssignments.update(assignment.groupId, {
    primaryConsultantUserId: consultant!.userId,
    updatedBy: adminUserId,
  });

  await logConsultantManagementEvent({
    action: 'admin_assign_consultant',
    actorUserId: adminUserId,
    payload: {
      group_id: assignment.groupId,
      group_code: groupCode,
      primary: consultant!.userId,
      secondary: assignment.secondaryConsultantUserId,
      assigned_by: adminUserId,
    },
  });

  return [
    {
      type: 'push',
      userId: adminUserId,
      text: `已設定 ${groupCode} 主負責為 ${consultant!.consultantCode ?? consultant!.userId}。`,
    },
  ];
}

async function assignPrimaryAndSecondary(
  adminUserId: string,
  groupCode: string,
  primaryCode: string,
  secondaryCode: string
): Promise<BotReply[]> {
  if (primaryCode === secondaryCode) {
    return [{ type: 'push', userId: adminUserId, text: '主負責不可等於副手。' }];
  }

  const assignment = await getRepos().groupConsultantAssignments.findByGroupCode(groupCode);
  if (!assignment) {
    return [{ type: 'push', userId: adminUserId, text: `找不到群組 ${groupCode}。` }];
  }

  const primary = await resolveConsultantByCodeOrUserId(primaryCode);
  const secondary = await resolveConsultantByCodeOrUserId(secondaryCode);
  const primaryValidation = await validateActiveAssignee(primary);
  if (!primaryValidation.ok) {
    return [{ type: 'push', userId: adminUserId, text: primaryValidation.message ?? '無法指派主負責。' }];
  }
  const secondaryValidation = await validateActiveAssignee(secondary);
  if (!secondaryValidation.ok) {
    return [
      { type: 'push', userId: adminUserId, text: secondaryValidation.message ?? '無法指派副手。' },
    ];
  }

  if (primary!.userId === secondary!.userId) {
    return [{ type: 'push', userId: adminUserId, text: '主負責不可等於副手。' }];
  }

  await getRepos().groupConsultantAssignments.update(assignment.groupId, {
    primaryConsultantUserId: primary!.userId,
    secondaryConsultantUserId: secondary!.userId,
    updatedBy: adminUserId,
  });

  await logConsultantManagementEvent({
    action: 'admin_assign_consultant',
    actorUserId: adminUserId,
    payload: {
      group_id: assignment.groupId,
      group_code: groupCode,
      primary: primary!.userId,
      secondary: secondary!.userId,
      assigned_by: adminUserId,
    },
  });

  return [
    {
      type: 'push',
      userId: adminUserId,
      text: `已設定 ${groupCode} 主負責 ${primaryCode}、副手 ${secondaryCode}。`,
    },
  ];
}

async function unassignGroup(adminUserId: string, groupCode: string): Promise<BotReply[]> {
  const assignment = await getRepos().groupConsultantAssignments.findByGroupCode(groupCode);
  if (!assignment) {
    return [{ type: 'push', userId: adminUserId, text: `找不到群組 ${groupCode}。` }];
  }

  await getRepos().groupConsultantAssignments.update(assignment.groupId, {
    primaryConsultantUserId: null,
    secondaryConsultantUserId: null,
    updatedBy: adminUserId,
  });

  await logConsultantManagementEvent({
    action: 'admin_unassign_consultant',
    actorUserId: adminUserId,
    payload: {
      group_id: assignment.groupId,
      group_code: groupCode,
      unassigned_by: adminUserId,
    },
  });

  return [
    {
      type: 'push',
      userId: adminUserId,
      text: `已解除 ${groupCode} 的主負責與副手。`,
    },
  ];
}

export async function rejectConsultantGroupList(userId: string, text: string): Promise<BotReply[] | null> {
  if (!isGroupListPhrase(text)) {
    return null;
  }
  if (await isActiveAdmin(userId)) {
    return null;
  }
  return [
    {
      type: 'push',
      userId,
      text: '「群組清單」僅 active admin 可使用。',
    },
  ];
}
