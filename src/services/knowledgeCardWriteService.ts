import { v4 as uuidv4 } from 'uuid';
import { BotReply } from '../types';
import {
  isActiveAdmin,
  isActiveConsultantOrAdmin,
  getConsultant,
} from './consultantWhitelist';
import { writeKnowledgeCardWithValidation } from './knowledgeCardWriteGate';
import {
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
import { KnowledgeCardDraftData } from '../schemas/knowledgeCardDraftSchema';
import { isPlaceholderCardId } from './knowledgeCardIdService';
import { buildConfirmSuccessPublicReplyNote } from './knowledgeCardPublicReplyService';
import { KnowledgeDraftMode } from './knowledgeCardDraftModeService';
import { safeLogKnowledgeDraftEdited } from './lowVolumeTodoEventLogService';
import {
  draftDataToKnowledgeCard,
  knowledgeCardToDraftData,
} from './knowledgeCardDraftMappingService';
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
    const draftData = knowledgeCardToDraftData(draft.card);
    await getRepos().dmSessions.submitDraftAtomically({
      userId,
      reviewId,
      cardData: draft.card,
      draftData,
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

  return [
    {
      type: 'push',
      userId,
      text: '已送出草稿至待審區，請等待 admin 確認更新。',
    },
  ];
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

  if (resolved.review) {
    card = resolved.review.draftData
      ? draftDataToKnowledgeCard(resolved.review.draftData)
      : resolved.review.card;
    summary = `admin confirmed consultant draft from ${resolved.review.consultantId}`;
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
  return [
    {
      type: 'push',
      userId: ctx.userId,
      text: [
        `${actionLabel}「${writeResult.cardId}｜${writeResult.title}」並寫入知識庫。`,
        buildConfirmSuccessPublicReplyNote(writtenCard),
      ].join('\n'),
    },
  ];
}

function parseDraftJsonPayload(jsonPart: string): KnowledgeCardDraftData | null {
  try {
    const parsed = JSON.parse(jsonPart) as Record<string, unknown>;
    if (parsed && typeof parsed === 'object' && 'public_answer_draft' in parsed) {
      return parsed as unknown as KnowledgeCardDraftData;
    }
    if (parsed && typeof parsed === 'object' && 'standard_answer' in parsed) {
      return knowledgeCardToDraftData(parsed as unknown as KnowledgeCard);
    }
    return null;
  } catch {
    return null;
  }
}

export function parseAdminEditDraftCommand(
  text: string
): { shortCode: string; draft: KnowledgeCardDraftData; editReason: string | null } | null {
  const match = text.match(/^編輯草稿\s+(KDR-\d{8}-[A-Z0-9]{2,}|K-\d{8}-[A-Z0-9]{2,})\s*([\s\S]+)$/i);
  if (!match) {
    return null;
  }
  const reasonMatch = match[2].match(/^原因[:：](.+?)\n+([\s\S]+)$/s);
  let editReason: string | null = null;
  let jsonPart = match[2].trim();
  if (reasonMatch) {
    editReason = reasonMatch[1].trim();
    jsonPart = reasonMatch[2].trim();
  }
  const draft = parseDraftJsonPayload(jsonPart);
  if (!draft) {
    return null;
  }
  return { shortCode: match[1], draft, editReason };
}

export async function handleAdminEditDraft(ctx: AdminActionContext): Promise<BotReply[]> {
  if (!(await isActiveAdmin(ctx.userId))) {
    return [{ type: 'push', userId: ctx.userId, text: '只有 active admin 可編輯待審草稿。' }];
  }

  const parsed = parseAdminEditDraftCommand(ctx.text);
  if (!parsed) {
    return [
      {
        type: 'push',
        userId: ctx.userId,
        text: '請使用「編輯草稿 K-YYYYMMDD-XX」+ JSON 格式，可選「原因：…」前綴。',
      },
    ];
  }

  const resolved = await resolveReviewTarget({
    text: `確認更新 ${parsed.shortCode}`,
    quotedMessageId: ctx.quotedMessageId,
  });
  if (resolved.error || !resolved.review) {
    return [{ type: 'push', userId: ctx.userId, text: resolved.error ?? '找不到待審草稿。' }];
  }

  const now = new Date().toISOString();
  const cardData = draftDataToKnowledgeCard(parsed.draft);
  await getRepos().pendingKnowledgeReviews.updateDraftData({
    reviewId: resolved.review.reviewId,
    draftData: parsed.draft,
    cardData,
    lastEditedBy: ctx.userId,
    lastEditedAt: now,
    editReason: parsed.editReason,
  });

  await safeLogKnowledgeDraftEdited({
    review_id: resolved.review.reviewId,
    edited_by: ctx.userId,
    edit_reason: parsed.editReason,
  });

  return [
    {
      type: 'push',
      userId: ctx.userId,
      text: `已更新草稿 ${parsed.shortCode}。請再輸入「確認更新 ${parsed.shortCode}」經驗證後寫入知識庫。`,
    },
  ];
}

function extractBatchConfirmShortCodes(text: string): string[] {
  const trimmed = text.trim();
  for (const phrase of CONFIRM_UPDATE_PHRASES) {
    if (trimmed.startsWith(`${phrase} `)) {
      const rest = trimmed.slice(phrase.length).trim();
      const codes = rest.match(/K-\d{8}-[A-Z0-9]{2,}/g);
      if (codes && codes.length > 1) {
        return [...new Set(codes)];
      }
    }
  }
  return [];
}

export async function handleBatchConfirmUpdate(ctx: AdminActionContext): Promise<BotReply[]> {
  const codes = extractBatchConfirmShortCodes(ctx.text);
  if (codes.length <= 1) {
    return handleConfirmUpdate(ctx);
  }

  const successes: string[] = [];
  const failures: Array<{ code: string; reason: string }> = [];

  for (const code of codes) {
    try {
      const result = await handleConfirmUpdate({
        ...ctx,
        text: `確認更新 ${code}`,
      });
      const text = result[0]?.text ?? '';
      if (text.includes('已新增知識卡') || text.includes('已更新知識卡')) {
        successes.push(code);
      } else {
        failures.push({ code, reason: text });
      }
    } catch (error) {
      failures.push({
        code,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const lines = [
    '【批次確認更新結果】',
    `成功 ${successes.length} 筆：${successes.length > 0 ? successes.join('、') : '無'}`,
    `失敗 ${failures.length} 筆`,
  ];
  for (const fail of failures) {
    lines.push(`- ${fail.code}: ${fail.reason}`);
  }
  return [{ type: 'push', userId: ctx.userId, text: lines.join('\n') }];
}

export async function handleConsultantConfirmUpdateAttempt(ctx: AdminActionContext): Promise<BotReply[]> {
  if (await isActiveAdmin(ctx.userId)) {
    if (extractBatchConfirmShortCodes(ctx.text).length > 1) {
      return handleBatchConfirmUpdate(ctx);
    }
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
      text: '已記錄修改意見，尚未寫入 DB。',
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

  return [{ type: 'push', userId: ctx.userId, text: '已退回草稿，尚未寫入 DB。' }];
}

export { isKnowledgeReviewShortCode };
