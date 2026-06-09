import { v4 as uuidv4 } from 'uuid';
import { BotReply } from '../types';
import {
  isActiveAdmin,
  isActiveConsultantOrAdmin,
  getConsultant,
  getActiveAdmins,
} from './consultantWhitelist';
import { writeKnowledgeCardWithValidation } from './knowledgeCardWriteGate';
import {
  formatPendingReviewList,
  listPendingReviews,
  resolveReviewTarget,
  registerReviewMessageMapping,
  getReviewIdByMessageId,
  seedPendingReviewForTest,
  markReviewApproved,
  markReviewRejected,
  saveReviewAdminResponse,
} from './knowledgeCardReviewService';
import {
  allocateUniqueKnowledgeReviewShortCode,
} from './knowledgeReviewShortCodeService';
import {
  extractKnowledgeReviewShortCode,
  isKnowledgeReviewShortCode,
  findKnowledgeReviewShortCodeCandidates,
} from './knowledgeReviewShortCodeService';
import {
  getSessionDraft,
  storeSessionDraft,
  deleteUserDraft,
  markSessionCompleted,
  storeSessionDraftFromRevision,
  setForceSubmitFailureForTest,
  getActiveSession,
  getActiveSessionDraftMode,
} from './dmSessionService';
import { NO_ACTIVE_DRAFT_SESSION_MESSAGE } from './knowledgeCardDraftService';
import { suppressPrivateFallbackForUser } from './privateFallbackHintService';
import { getRepos } from '../repositories';
import { KnowledgeCard } from '../schemas/knowledgeCardSchema';
import { isPlaceholderCardId } from './knowledgeCardIdService';
import { buildConfirmSuccessPublicReplyNote } from './knowledgeCardPublicReplyService';
import { KnowledgeDraftMode } from './knowledgeCardDraftModeService';

export const CONFIRM_SUBMIT_PHRASE = '確認送出';
export const CONFIRM_UPDATE_PHRASES = ['確認更新', '确认更新'] as const;
export const CONFIRM_BULK_IMPORT_PHRASE = '確認批量匯入';
export const REJECT_PHRASE = '退回';

export {
  clearKnowledgeCardReviewState as clearKnowledgeCardWriteState,
  registerReviewMessageMapping,
  getReviewIdByMessageId,
  seedPendingReviewForTest,
  listPendingReviews,
} from './knowledgeCardReviewService';

export {
  storeSessionDraft as storeUserDraft,
  getSessionDraft as getUserDraft,
  deleteUserDraft,
  setForceSubmitFailureForTest,
} from './dmSessionService';

export function getPendingReviewCount(): Promise<number> {
  return listPendingReviews().then((list) => list.length);
}

export interface AdminActionContext {
  userId: string;
  text: string;
  quotedMessageId?: string;
}

export function isConfirmSubmitPhrase(text: string): boolean {
  return text.trim() === CONFIRM_SUBMIT_PHRASE;
}

export function matchesBareConfirmUpdatePhrase(text: string): boolean {
  return CONFIRM_UPDATE_PHRASES.includes(text.trim() as (typeof CONFIRM_UPDATE_PHRASES)[number]);
}

export function matchesConfirmUpdateCommand(text: string): boolean {
  const trimmed = text.trim();
  if (matchesBareConfirmUpdatePhrase(trimmed)) {
    return true;
  }
  for (const phrase of CONFIRM_UPDATE_PHRASES) {
    if (trimmed.startsWith(`${phrase} `) && extractKnowledgeReviewShortCode(trimmed)) {
      return true;
    }
  }
  return false;
}

export function parseRevisionFeedback(text: string): { shortCode?: string; feedback: string } | null {
  const withCode = text.match(/^需要修改\s+(K-\d{8}-[A-Z0-9]{2,})[:：]\s*(.+)/s);
  if (withCode) {
    return { shortCode: withCode[1], feedback: withCode[2].trim() };
  }
  const loose = text.match(/^需要修改\s+(.+?)[:：]\s*(.+)/s);
  if (loose) {
    const codes = findKnowledgeReviewShortCodeCandidates(loose[1]);
    if (codes.length === 1) {
      return { shortCode: codes[0], feedback: loose[2].trim() };
    }
    if (codes.length > 1) {
      return { feedback: loose[2].trim() };
    }
  }
  const plain = text.match(/^需要修改[:：]\s*(.+)/s);
  if (plain) {
    return { feedback: plain[1].trim() };
  }
  return null;
}

export function parseRejectCommand(text: string): { shortCode?: string; rawTarget?: string } | null {
  const trimmed = text.trim();
  if (trimmed === REJECT_PHRASE) {
    return {};
  }
  const match = trimmed.match(/^退回\s+(K-\d{8}-[A-Z0-9]{2,})$/);
  if (match) {
    return { shortCode: match[1] };
  }
  const loose = trimmed.match(/^退回\s+(.+)$/);
  if (loose) {
    const codes = findKnowledgeReviewShortCodeCandidates(loose[1]);
    if (codes.length > 1) {
      return { rawTarget: loose[1].trim() };
    }
  }
  return null;
}

export function isRejectCommand(text: string): boolean {
  return parseRejectCommand(text) !== null;
}

async function inferDraftModeForWrite(card: KnowledgeCard): Promise<KnowledgeDraftMode> {
  if (isPlaceholderCardId(card.card_id)) {
    return 'create';
  }
  const existing = await getRepos().knowledgeCards.findById(card.card_id);
  return existing ? 'update' : 'create';
}

async function writeValidatedCard(
  card: Parameters<typeof writeKnowledgeCardWithValidation>[0]['card'],
  operatorUserId: string,
  operation: 'create' | 'update' | 'import',
  summary: string,
  validationOperation: string,
  reviewShortCode?: string,
  options?: {
    logValidationFailure?: boolean;
    buildFailureMessage?: (params: { cardId: string; error: string }) => string;
    draftMode?: KnowledgeDraftMode;
  }
): Promise<
  | { ok: true; cardId: string; title: string; effectiveOperation: 'create' | 'update' }
  | { ok: false; replies: BotReply[] }
> {
  const result = await writeKnowledgeCardWithValidation({
    card,
    operatorUserId,
    operation,
    summary,
    validationOperation,
    reviewShortCode,
    logValidationFailure: options?.logValidationFailure,
    draftMode: options?.draftMode,
  });
  if (!result.ok) {
    const error = result.error ?? '未知錯誤';
    const text = options?.buildFailureMessage
      ? options.buildFailureMessage({ cardId: result.cardId, error })
      : `知識卡「${result.cardId}」驗證失敗，未寫入 DB。\n原因：${error}`;
    return {
      ok: false,
      replies: [
        {
          type: 'push',
          userId: operatorUserId,
          text,
        },
      ],
    };
  }
  return {
    ok: true,
    cardId: result.cardId,
    title: card.title,
    effectiveOperation: result.effectiveOperation ?? 'create',
  };
}

function buildOwnDraftConfirmValidationFailureMessage(params: {
  cardId: string;
  error: string;
}): string {
  return [
    `知識卡「${params.cardId}」驗證失敗，尚未寫入知識庫。`,
    '',
    params.error,
    '',
    '草稿已保留，可輸入「修改：…」調整後再輸入「確認更新」。',
  ].join('\n');
}

export async function handleConsultantConfirmSubmit(userId: string): Promise<BotReply[]> {
  const consultant = await getConsultant(userId);
  if (!consultant || consultant.status !== 'active') {
    return [{ type: 'push', userId, text: '您的身份不可確認送出。' }];
  }
  if (!(await isActiveConsultantOrAdmin(userId))) {
    return [{ type: 'push', userId, text: '只有 active 顧問或 admin 可確認送出。' }];
  }
  if (await isActiveAdmin(userId)) {
    return [
      {
        type: 'push',
        userId,
        text: '您是 admin，請輸入「確認更新」讓知識卡正式生效。',
      },
    ];
  }

  const draft = await getSessionDraft(userId);
  if (!draft) {
    suppressPrivateFallbackForUser(userId);
    return [{ type: 'push', userId, text: NO_ACTIVE_DRAFT_SESSION_MESSAGE }];
  }

  const activeSession = await getActiveSession(userId);
  if (activeSession?.draftData?.validationStatus === 'failed') {
    return [
      {
        type: 'push',
        userId,
        text: '目前草稿尚未通過驗證，請先輸入「修改：…」調整後再「確認送出」。',
      },
    ];
  }

  const submittedAt = new Date().toISOString();
  const pendingIds = new Set(
    (await getRepos().pendingKnowledgeReviews.listPending()).map((r) => r.reviewId)
  );
  const reviewId = allocateUniqueKnowledgeReviewShortCode(uuidv4(), submittedAt, (code) =>
    pendingIds.has(code)
  );

  try {
    await getRepos().dmSessions.submitDraftAtomically({
      userId,
      reviewId,
      cardData: draft.card,
      submittedAt,
      draftText: draft.draftText,
    });
  } catch {
    return [
      {
        type: 'push',
        userId,
        text: '送出草稿時發生錯誤，草稿仍保留在本機 session，請稍後再試。',
      },
    ];
  }

  const pendingRecord = await getRepos().pendingKnowledgeReviews.findById(reviewId);
  if (!pendingRecord) {
    return [
      {
        type: 'push',
        userId,
        text: '送出草稿時發生錯誤，草稿仍保留在本機 session，請稍後再試。',
      },
    ];
  }

  const review = {
    reviewId,
    shortCode: reviewId,
    consultantId: userId,
    consultantName: consultant.displayName,
    submittedAt,
    card: draft.card,
    draftText: draft.draftText,
  };

  const adminReplies: BotReply[] = [
    {
      type: 'push',
      userId,
      text: '已送出草稿給 admin 審核，請等待 admin 確認更新。',
    },
  ];

  const admins = await getActiveAdmins();
  const pendingList = await listPendingReviews();
  const pushBody = [
    '【顧問知識卡草稿待審】',
    `待審短碼：${review.shortCode}`,
    `review_id：${review.reviewId}`,
    `顧問名稱：${consultant.displayName ?? '（未設定）'}`,
    `顧問 userId：${userId}`,
    `送出時間：${review.submittedAt}`,
    '',
    '【草稿全文】',
    draft.draftText,
    '',
    `可回覆「確認更新 ${review.shortCode}」寫入 DB。`,
    `或「需要修改 ${review.shortCode}：…」推回顧問，或「退回 ${review.shortCode}」。`,
    pendingList.length > 1 ? `\n【目前待審清單】\n${formatPendingReviewList(pendingList)}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  for (const admin of admins) {
    adminReplies.push({
      type: 'push',
      userId: admin.userId,
      text: pushBody,
      trackReviewId: review.reviewId,
    });
  }

  return adminReplies;
}

export async function handleConfirmUpdate(ctx: AdminActionContext): Promise<BotReply[]> {
  if (!(await isActiveAdmin(ctx.userId))) {
    return [
      {
        type: 'push',
        userId: ctx.userId,
        text: '只有 active admin 可確認更新並寫入 DB。',
      },
    ];
  }

  const activeSession = await getActiveSession(ctx.userId);
  if (activeSession?.draftData?.validationStatus === 'failed') {
    return [
      {
        type: 'push',
        userId: ctx.userId,
        text: '目前草稿尚未通過驗證，請先輸入「修改：…」調整後再確認更新。',
      },
    ];
  }

  const resolved = await resolveReviewTarget({
    text: ctx.text,
    quotedMessageId: ctx.quotedMessageId,
    allowOwnDraft: true,
    adminUserId: ctx.userId,
  });

  if (resolved.error) {
    return [{ type: 'push', userId: ctx.userId, text: resolved.error }];
  }

  let card;
  let summary = '';
  let notifyConsultantId: string | null = null;

  if (resolved.review) {
    card = resolved.review.card;
    summary = `admin confirmed consultant draft from ${resolved.review.consultantId}`;
    notifyConsultantId = resolved.review.consultantId;
  } else if (resolved.ownDraft) {
    card = resolved.ownDraft.card;
    summary = 'admin self-organized knowledge card';
  } else {
    return [{ type: 'push', userId: ctx.userId, text: '目前沒有待確認的知識卡草稿。' }];
  }

  const isOwnDraft = Boolean(resolved.ownDraft);
  const ownDraftMode = isOwnDraft ? await getActiveSessionDraftMode(ctx.userId) : undefined;
  const draftMode =
    ownDraftMode ?? (await inferDraftModeForWrite(card));

  const writeResult = await writeValidatedCard(
    card,
    ctx.userId,
    'create',
    summary,
    'confirm_update',
    resolved.review?.shortCode,
    isOwnDraft
      ? {
          logValidationFailure: false,
          buildFailureMessage: buildOwnDraftConfirmValidationFailureMessage,
          draftMode,
        }
      : { draftMode }
  );
  if (!writeResult.ok) {
    return writeResult.replies;
  }

  const writtenCard = {
    ...card,
    card_id: writeResult.cardId,
  };

  if (resolved.review) {
    await markReviewApproved(resolved.review.reviewId, ctx.userId);
  } else {
    await markSessionCompleted(ctx.userId);
  }

  const actionLabel =
    writeResult.effectiveOperation === 'update' ? '已更新知識卡' : '已新增知識卡';
  const replies: BotReply[] = [
    {
      type: 'push',
      userId: ctx.userId,
      text: [
        `${actionLabel}「${writeResult.cardId}｜${writeResult.title}」並寫入知識庫。`,
        buildConfirmSuccessPublicReplyNote(writtenCard),
      ].join('\n'),
    },
  ];

  if (
    notifyConsultantId &&
    (await getConsultant(notifyConsultantId))?.status === 'active' &&
    !(await isActiveAdmin(notifyConsultantId))
  ) {
    replies.push({
      type: 'push',
      userId: notifyConsultantId,
      text: [
        `admin 已確認更新您的知識卡草稿（${writeResult.cardId}｜${writeResult.title}），正式生效。`,
        buildConfirmSuccessPublicReplyNote(writtenCard),
      ].join('\n'),
    });
  }

  return replies;
}

export async function handleConsultantConfirmUpdateAttempt(ctx: AdminActionContext): Promise<BotReply[]> {
  if (await isActiveAdmin(ctx.userId)) {
    return handleConfirmUpdate(ctx);
  }
  suppressPrivateFallbackForUser(ctx.userId);
  return [
    {
      type: 'push',
      userId: ctx.userId,
      text: '只有 active admin 可確認更新。顧問請使用「確認送出」將草稿送給 admin。',
    },
  ];
}

export async function handleAdminRevisionFeedback(ctx: AdminActionContext): Promise<BotReply[]> {
  if (!(await isActiveAdmin(ctx.userId))) {
    return [{ type: 'push', userId: ctx.userId, text: '只有 active admin 可回覆修改意見。' }];
  }

  const parsed = parseRevisionFeedback(ctx.text);
  if (!parsed) {
    return [{ type: 'push', userId: ctx.userId, text: '請使用「需要修改 K-YYYYMMDD-XX：…」格式。' }];
  }

  const lookupText = parsed.shortCode
    ? `需要修改 ${parsed.shortCode}：${parsed.feedback}`
    : ctx.text;
  const resolved = await resolveReviewTarget({
    text: lookupText,
    quotedMessageId: parsed.shortCode ? undefined : ctx.quotedMessageId,
  });

  if (resolved.error || !resolved.review) {
    return [{ type: 'push', userId: ctx.userId, text: resolved.error ?? '目前沒有待審核的顧問草稿。' }];
  }

  const queued = resolved.review;
  await saveReviewAdminResponse(queued.reviewId, parsed.feedback);

  await storeSessionDraftFromRevision(
    queued.consultantId,
    queued.card,
    queued.draftText
  );

  return [
    {
      type: 'push',
      userId: ctx.userId,
      text: '已將修改意見推回顧問，尚未寫入 DB。',
    },
    {
      type: 'push',
      userId: queued.consultantId,
      text: [`【admin 修改意見】`, parsed.feedback, '', '請修改後重新整理知識卡並「確認送出」。'].join(
        '\n'
      ),
    },
  ];
}

export async function handleAdminRejectDraft(ctx: AdminActionContext): Promise<BotReply[]> {
  if (!(await isActiveAdmin(ctx.userId))) {
    return [{ type: 'push', userId: ctx.userId, text: '只有 active admin 可退回草稿。' }];
  }

  const parsed = parseRejectCommand(ctx.text);
  if (!parsed) {
    return [{ type: 'push', userId: ctx.userId, text: '請使用「退回」或「退回 K-YYYYMMDD-XX」。' }];
  }

  const lookupText = parsed.shortCode
    ? `退回 ${parsed.shortCode}`
    : parsed.rawTarget
      ? `退回 ${parsed.rawTarget}`
      : ctx.text;
  const resolved = await resolveReviewTarget({
    text: lookupText,
    quotedMessageId: parsed.shortCode ? undefined : ctx.quotedMessageId,
  });

  if (resolved.error || !resolved.review) {
    return [{ type: 'push', userId: ctx.userId, text: resolved.error ?? '目前沒有待審核的顧問草稿。' }];
  }

  const queued = resolved.review;
  await markReviewRejected(queued.reviewId, ctx.userId);

  return [
    { type: 'push', userId: ctx.userId, text: '已退回顧問草稿，尚未寫入 DB。' },
    {
      type: 'push',
      userId: queued.consultantId,
      text: '您的知識卡草稿已被 admin 退回，請修改後重新整理並「確認送出」。',
    },
  ];
}

export { isKnowledgeReviewShortCode };
