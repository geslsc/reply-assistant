import { BotReply } from '../types';
import { getRepos } from '../repositories';
import { isActiveAdmin, isActiveConsultantOrAdmin } from './consultantWhitelist';
import {
  findOpenHandoffByShortCode,
  getOpenPendingHandoffs,
  getPendingHandoffs,
  formatGroupLabelForHandoff,
} from './pendingHandoffService';
import {
  formatPendingReviewList,
  listPendingReviews,
} from './knowledgeCardReviewService';
import { getCardById } from './knowledgeBaseService';
import { dbRecordToKnowledgeCard } from '../schemas/knowledgeCardDbSchema';
import { formatServicePeriodStatus, parseServicePeriodQuery } from './servicePeriodService';
import { getGroupDisplayName } from './lineGroupSummaryService';
import { formatAssignmentGroupLabel } from './groupConsultantAssignmentService';

const Q_CODE_PATTERN = /^Q-\d{8}-\d{4}-[A-Z0-9]{2}$/u;
const K_CODE_PATTERN = /^K-\d{8}-[A-Z0-9]{2,}$/u;
const KC_CODE_PATTERN = /^kc-\d{8}-\d{3}$/iu;

export function parseBareCode(text: string): string | null {
  const trimmed = text.trim();
  if (Q_CODE_PATTERN.test(trimmed) || K_CODE_PATTERN.test(trimmed) || KC_CODE_PATTERN.test(trimmed)) {
    return trimmed;
  }
  if (/^\d{3}$/.test(trimmed)) {
    return trimmed;
  }
  return null;
}

export async function handleBareCodeLookup(userId: string, code: string): Promise<BotReply[] | null> {
  if (Q_CODE_PATTERN.test(code)) {
    const handoff = await findOpenHandoffByShortCode(userId, code);
    if (!handoff) {
      return [{ type: 'push', userId, text: `找不到待處理問題 ${code}。` }];
    }
    const groupName = await getGroupDisplayName(handoff.groupId);
    return [
      {
        type: 'push',
        userId,
        text: [
          `我找到這筆待處理問題：${handoff.shortCode}`,
          '',
          `群組：${formatGroupLabelForHandoff(handoff.groupId, groupName)}`,
          `店家問題：${handoff.customerQuestion ?? '（無摘要）'}`,
          `狀態：${handoff.snoozed ? '稍後處理' : '未處理'}`,
          '',
          '您可以回覆：',
          `- 輸入短碼查看詳情：${handoff.shortCode}`,
          `- ${handoff.shortCode} 稍後處理`,
          `- ${handoff.shortCode} 整理成知識卡`,
          '- 於私訊撰寫回覆草稿（replyMessage）',
        ].join('\n'),
      },
    ];
  }

  if (K_CODE_PATTERN.test(code)) {
    const pendingList = await listPendingReviews();
    const review = pendingList.find((item) => item.shortCode === code);
    if (!review) {
      return [{ type: 'push', userId, text: `找不到待審知識卡草稿 ${code}。` }];
    }
    return [
      {
        type: 'push',
        userId,
        text: [
          `我找到這份待審知識卡草稿：${code}`,
          '',
          formatPendingReviewList([review]),
          '',
          '您可以回覆：',
          `- 確認更新 ${code}`,
          `- 需要修改 ${code}：...`,
          `- 退回 ${code}`,
          `- 查看 ${code}`,
        ].join('\n'),
      },
    ];
  }

  const cardRecord =
    (await getRepos().knowledgeCards.findById(code)) ??
    (KC_CODE_PATTERN.test(code) ? null : await getRepos().knowledgeCards.findById(`kc-${code}`));
  if (cardRecord) {
    const card = dbRecordToKnowledgeCard(cardRecord);
    return [
      {
        type: 'push',
        userId,
        text: [
          `我找到這張知識卡：${card.card_id}｜${card.title}`,
          '',
          '您可以回覆：',
          '- 查看這張知識卡',
          '- 修改這張知識卡',
          '- 暫停這張知識卡',
          '- 恢復這張知識卡',
        ].join('\n'),
      },
    ];
  }

  return null;
}

export async function handleGroupNameLookup(userId: string, groupName: string): Promise<BotReply[] | null> {
  const groups = await getRepos().groups.findAll();
  const matches = groups.filter((g) => g.groupName === groupName);
  if (matches.length === 0) {
    return [{ type: 'push', userId, text: `找不到群組「${groupName}」。` }];
  }
  if (matches.length > 1) {
    return [
      {
        type: 'push',
        userId,
        text: [
          `找到多個名稱為「${groupName}」的群組，請指定 groupId 或更完整的名稱：`,
          ...matches.map((g) => `- ${g.groupId}`),
        ].join('\n'),
      },
    ];
  }
  return [
    {
      type: 'push',
      userId,
      text: [
        `我找到群組：${groupName}`,
        '',
        '您可以回覆：',
        `- 查詢服務期 ${groupName}`,
        `- 查看待處理問題 ${groupName}`,
        `- 小助手群組狀態 ${groupName}`,
      ].join('\n'),
    },
  ];
}

async function resolveGroupForPrivateQuery(
  query: string
): Promise<
  | { ok: true; groupId: string }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'ambiguous'; candidates: string[] }
> {
  const trimmed = query.trim();
  const assignments = await getRepos().groupConsultantAssignments.listAll();
  const byCode = assignments.find((assignment) => assignment.groupCode === trimmed);
  if (byCode) {
    return { ok: true, groupId: byCode.groupId };
  }

  const groups = await getRepos().groups.findAll();
  const labels = new Map<string, string>();
  for (const group of groups) {
    if (group.groupName) {
      labels.set(group.groupId, group.groupName);
    }
  }
  for (const assignment of assignments) {
    if (assignment.groupName) {
      labels.set(assignment.groupId, formatAssignmentGroupLabel(assignment));
    }
  }

  const exactIds = [...labels.entries()]
    .filter(([, label]) => label === trimmed)
    .map(([groupId]) => groupId);
  if (exactIds.length === 1) {
    return { ok: true, groupId: exactIds[0] };
  }
  if (exactIds.length > 1) {
    return {
      ok: false,
      reason: 'ambiguous',
      candidates: exactIds.map((groupId) => `${labels.get(groupId)}（${groupId}）`),
    };
  }

  const partialIds = [...labels.entries()]
    .filter(([, label]) => label.includes(trimmed) || trimmed.includes(label))
    .map(([groupId]) => groupId);
  const uniquePartialIds = [...new Set(partialIds)];
  if (uniquePartialIds.length === 1) {
    return { ok: true, groupId: uniquePartialIds[0] };
  }
  if (uniquePartialIds.length > 1) {
    return {
      ok: false,
      reason: 'ambiguous',
      candidates: uniquePartialIds.map((groupId) => `${labels.get(groupId)}（${groupId}）`),
    };
  }

  return { ok: false, reason: 'not_found' };
}

export async function handlePrivateCodeNavigation(
  userId: string,
  text: string
): Promise<BotReply[] | null> {
  if (!(await isActiveConsultantOrAdmin(userId))) {
    return null;
  }

  const serviceQuery = parseServicePeriodQuery(text);
  if (serviceQuery) {
    if (!(await isActiveAdmin(userId))) {
      return [
        {
          type: 'push',
          userId,
          text: '目前尚未開放顧問查詢所有群組服務期，請洽管理者。',
        },
      ];
    }
    if (serviceQuery.groupName) {
      const match = await resolveGroupForPrivateQuery(serviceQuery.groupName);
      if (match.ok) {
        return [{ type: 'push', userId, text: await formatServicePeriodStatus(match.groupId) }];
      }
      if (match.reason === 'ambiguous') {
        return [
          {
            type: 'push',
            userId,
            text: `找到多個相近群組，請改用 group_code 查詢：\n${match.candidates.join('\n')}`,
          },
        ];
      }
      if (!match.ok) {
        return [{ type: 'push', userId, text: `找不到群組「${serviceQuery.groupName}」。` }];
      }
    }
    return [
      {
        type: 'push',
        userId,
        text: '請指定群組名稱，例如：查詢服務期 大寶寶測試群',
      },
    ];
  }

  const bareCode = parseBareCode(text);
  if (bareCode) {
    return handleBareCodeLookup(userId, bareCode);
  }

  const viewPendingMatch = text.trim().match(/^查看待處理問題\s+(.+)$/u);
  if (viewPendingMatch) {
    const groupName = viewPendingMatch[1].trim();
    const groups = await getRepos().groups.findAll();
    const match = groups.find((g) => g.groupName === groupName);
    if (!match) {
      return [{ type: 'push', userId, text: `找不到群組「${groupName}」。` }];
    }
    const handoffs = (await getOpenPendingHandoffs(userId)).filter(
      (h) => h.groupId === match.groupId
    );
    if (handoffs.length === 0) {
      return [{ type: 'push', userId, text: `群組「${groupName}」目前沒有待處理問題。` }];
    }
    return [
      {
        type: 'push',
        userId,
        text: handoffs
          .map((h) => `${h.shortCode}｜${h.customerQuestion ?? '（無摘要）'}`)
          .join('\n'),
      },
    ];
  }

  const viewGroupMatch = text.trim().match(/^查看群組\s+(.+)$/u);
  if (viewGroupMatch) {
    return handleGroupNameLookup(userId, viewGroupMatch[1].trim());
  }

  if (/^小助手群組狀態\s+/u.test(text.trim())) {
    const name = text.trim().replace(/^小助手群組狀態\s+/u, '').trim();
    return handleGroupNameLookup(userId, name);
  }

  const groups = await getRepos().groups.findAll();
  const exactGroupMatches = groups.filter((g) => g.groupName === text.trim());
  if (exactGroupMatches.length === 1 && text.trim().length > 0) {
    return handleGroupNameLookup(userId, exactGroupMatches[0].groupName!);
  }

  return null;
}
