import { BotReply } from '../types';
import {
  classifyConsultantIntent,
  ConsultantIntent,
  isConsultantPrivateAiIntent,
  isDirectExecuteIntent,
  requiresConfirmation,
} from './consultantIntentClassifier';
import { isConfirmationPhrase } from './consultantConfirmationService';
import { getRepos } from '../repositories';
import {
  getConsultant,
  isActiveConsultantOrAdmin,
} from './consultantWhitelist';

export const IDENTITY_QUERY_PHRASES = [
  '我的層級',
  '我的身份',
  '我的權限',
  '我的 userId',
  '我是誰',
  '查詢我的身份',
] as const;

export const ACTIVE_PRIVATE_FALLBACK_HINT =
  '已收到。若要查身份請輸入「我的層級」；若要整理知識卡請輸入「整理知識卡：...」。';

export function isIdentityQueryPhrase(text: string): boolean {
  const trimmed = text.trim();
  return IDENTITY_QUERY_PHRASES.includes(trimmed as (typeof IDENTITY_QUERY_PHRASES)[number]);
}

export async function buildIdentityReply(userId: string): Promise<string> {
  const record = await getConsultant(userId);
  const canUseWorkflow = await isActiveConsultantOrAdmin(userId);

  if (!record) {
    return [
      `LINE userId: ${userId}`,
      'role: 無',
      'status: 未註冊',
      '待辦處理：否',
      'AI 草稿整理：否',
    ].join('\n');
  }

  return [
    `LINE userId: ${userId}`,
    `role: ${record.role}`,
    `status: ${record.status}`,
    `待辦處理：${canUseWorkflow ? '是' : '否'}`,
    `AI 草稿整理：${canUseWorkflow ? '是' : '否'}`,
  ].join('\n');
}

function isPrivateConsultantWorkflowIntent(intent: ConsultantIntent): boolean {
  return (
    intent !== ConsultantIntent.UNKNOWN &&
    (isConsultantPrivateAiIntent(intent) ||
      requiresConfirmation(intent) ||
      isDirectExecuteIntent(intent))
  );
}

/** 非 active 身份嘗試顧問工作流程時回覆阻擋訊息 */
export async function buildInactiveWorkflowBlockReply(
  userId: string,
  text: string
): Promise<BotReply[] | null> {
  if (await isActiveConsultantOrAdmin(userId)) {
    return null;
  }

  if (isConfirmationPhrase(text)) {
    return [
      {
        type: 'push',
        userId,
        text: '您目前身份不可使用顧問工作流程（含代回確認）。',
      },
    ];
  }

  const { intent } = classifyConsultantIntent(text);
  if (!isPrivateConsultantWorkflowIntent(intent)) {
    return null;
  }

  const record = await getConsultant(userId);
  let statusLabel: string;
  if (record) {
    statusLabel = record.status;
  } else {
    const pendingApplication =
      await getRepos().consultantApplications.findPendingByUserId(userId);
    statusLabel = pendingApplication ? 'pending（申請審核中）' : '未註冊';
  }
  return [
    {
      type: 'push',
      userId,
      text: `您目前身份（${statusLabel}）不可使用此顧問功能。`,
    },
  ];
}
