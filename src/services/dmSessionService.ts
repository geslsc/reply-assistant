import { v4 as uuidv4 } from 'uuid';
import { BotReply } from '../types';
import { getEnv } from '../config/env';
import { getRepos } from '../repositories';
import { DmSessionDraftData, DmSessionRecord } from '../repositories/dmSessionTypes';
import { KnowledgeCard } from '../schemas/knowledgeCardSchema';
import {
  extractOrganizePayloadFromText,
  formatDraftJson,
  formatDraftReply,
  formatHumanReadableKnowledgeCard,
  generateKnowledgeCardDraft,
  hasMinimumDraftInput,
  INSUFFICIENT_DRAFT_INPUT_MESSAGE,
  NO_ACTIVE_DRAFT_SESSION_MESSAGE,
} from './knowledgeCardDraftService';
import { formatValidationErrorsForHuman } from './knowledgeCardValidationMessages';
import { enforceKnowledgeCardRules } from './knowledgeCardValidator';
import { isActiveAdmin, isActiveConsultantOrAdmin } from './consultantWhitelist';
import {
  resetPrivateFallbackForUser,
  suppressPrivateFallbackForUser,
} from './privateFallbackHintService';
import {
  handleConsultantConfirmSubmit,
  handleConsultantConfirmUpdateAttempt,
  isConfirmSubmitPhrase,
  matchesConfirmUpdateCommand,
} from './knowledgeCardWriteService';
import {
  handleViewPendingHandoffs,
  isViewPendingHandoffsPhrase,
} from './pendingHandoffService';
import {
  buildVisionSummaryMessage,
  isVisionConfirmPhrase,
} from './screenshotVisionSummaryService';
import {
  buildOrganizeContentFromHandoff,
  consumeHandoffReplyContext,
  isOrganizeFromHandoffPhrase,
} from './handoffKnowledgeDraftService';
import type { MemoryDmSessionRepository } from '../repositories/memoryDmSessionRepository';

export interface DmSessionMessageContext {
  userId: string;
  text: string;
  quotedMessageId?: string;
}

export interface StoredDraft {
  card: KnowledgeCard;
  draftJson: string;
  draftText: string;
  storedAt: string;
}

const ORGANIZE_START_PATTERN = /^(幫我整理知識卡|整理知識卡|新增知識卡)([:：]\s*)?/u;
const SUPPLEMENT_PATTERN = /^補充[:：]\s*/u;
const MODIFY_PATTERN = /^修改[:：]\s*/u;
const REGENERATE_PHRASE = '重新整理';
const EXPORT_JSON_PHRASE = '轉成 JSON';
const COMPLETE_PHRASE = '完成';
const CANCEL_PHRASES = ['取消', '停止整理', '先不用'] as const;
const AMBIGUOUS_ACK_PHRASES = ['好', '了解', '先這樣', '謝謝'] as const;
const EXISTING_SESSION_PROMPT = '您有一份未完成的草稿，要繼續還是取消？';
const START_CONTENT_PROMPT = [
  '請提供以下資訊：',
  '- 店家常問的問題',
  '- 您建議的回答方式',
  '- 適用情境',
  '- 不適用情境',
  '- 需要轉顧問的情況',
  '',
  '提供後我會整理成草稿，再請您「確認送出」給 Admin。',
].join('\n');
const EXPIRED_SESSION_MESSAGE =
  '先前的草稿已超過 24 小時未操作，已自動過期。如需重新整理，請輸入「幫我整理知識卡」。';
const INACTIVE_DRAFT_MESSAGE = '您的帳號尚未啟用或無權限使用草稿整理功能。';
const AMBIGUOUS_ACTIVE_SESSION_HINT =
  '草稿已暫停，需要時可輸入「補充：…」或「完成」。';
const UNRELATED_ACTIVE_SESSION_HINT =
  '目前仍在整理草稿中。請提供知識卡內容，或使用「補充：…」「修改：…」「重新整理」「轉成 JSON」「完成」或「取消」。';

function nowIso(): string {
  return new Date().toISOString();
}

function sessionTimeoutMs(): number {
  const hours = getEnv().DM_SESSION_TIMEOUT_HOURS;
  return hours * 60 * 60 * 1000;
}

function isBareOrganizeStart(text: string): boolean {
  return /^(幫我整理知識卡|整理知識卡|新增知識卡)$/.test(text.trim());
}

function isOrganizeStart(text: string): boolean {
  return ORGANIZE_START_PATTERN.test(text.trim());
}

function extractOrganizeContent(text: string): string {
  return extractOrganizePayloadFromText(text);
}

function isCancelPhrase(text: string): boolean {
  return CANCEL_PHRASES.includes(text.trim() as (typeof CANCEL_PHRASES)[number]);
}

function isAmbiguousAck(text: string): boolean {
  return AMBIGUOUS_ACK_PHRASES.includes(text.trim() as (typeof AMBIGUOUS_ACK_PHRASES)[number]);
}

function draftDataToStoredDraft(session: DmSessionRecord): StoredDraft | undefined {
  const card = session.draftData?.card ?? session.draftData?.lastInvalidDraft;
  if (!card) {
    return undefined;
  }
  return {
    card,
    draftJson: session.draftData?.draftJson ?? JSON.stringify(card, null, 2),
    draftText: session.draftData?.draftText ?? '',
    storedAt: session.updatedAt,
  };
}

function validationSignature(result: Awaited<ReturnType<typeof generateKnowledgeCardDraft>>): string {
  if (result.kind !== 'single_card') {
    return '';
  }
  return result.validation.errors.map((error) => `${error.field}:${error.message}`).join(';');
}

function buildDraftDataFromResult(
  card: KnowledgeCard,
  draftJson: string,
  draftText: string,
  inputNotes?: string,
  extra?: Partial<DmSessionDraftData>
): DmSessionDraftData {
  return {
    card,
    draftJson,
    draftText,
    humanReadableDraft: draftText,
    inputNotes,
    validationStatus: 'valid',
    validationFailureReason: undefined,
    lastInvalidDraft: undefined,
    lastValidationSignature: undefined,
    validationFailureCount: 0,
    ...extra,
  };
}

function pushReply(userId: string, text: string): BotReply[] {
  return [{ type: 'push', userId, text }];
}

export function clearDmSessionState(): void {
  const repo = getRepos().dmSessions as MemoryDmSessionRepository & {
    setForceSubmitFailure?: (value: boolean) => void;
  };
  repo.setForceSubmitFailure?.(false);
}

export function setForceSubmitFailureForTest(value: boolean): void {
  const repo = getRepos().dmSessions as MemoryDmSessionRepository & {
    setForceSubmitFailure?: (value: boolean) => void;
  };
  repo.setForceSubmitFailure?.(value);
}

export async function getActiveSession(userId: string): Promise<DmSessionRecord | null> {
  return getRepos().dmSessions.findActiveByUserId(userId);
}

export async function getSessionDraft(userId: string): Promise<StoredDraft | undefined> {
  const session = await getActiveSession(userId);
  return session ? draftDataToStoredDraft(session) : undefined;
}

export async function storeSessionDraft(
  userId: string,
  card: KnowledgeCard,
  draftJson: string,
  draftText: string
): Promise<void> {
  const session = await getActiveSession(userId);
  const draftData = buildDraftDataFromResult(card, draftJson, draftText);
  const updatedAt = nowIso();
  if (session) {
    await getRepos().dmSessions.updateDraftData(session.sessionId, draftData, updatedAt);
    return;
  }
  await getRepos().dmSessions.create({
    sessionId: uuidv4(),
    userId,
    sessionType: 'knowledge_draft',
    draftData,
    createdAt: updatedAt,
    updatedAt,
  });
}

export async function expireStaleSessionIfNeeded(userId: string): Promise<BotReply[] | null> {
  const session = await getActiveSession(userId);
  if (!session) {
    return null;
  }
  const elapsed = Date.now() - new Date(session.updatedAt).getTime();
  if (elapsed <= sessionTimeoutMs()) {
    return null;
  }
  await getRepos().dmSessions.markExpired(session.sessionId, nowIso(), nowIso());
  return pushReply(userId, EXPIRED_SESSION_MESSAGE);
}

async function createActiveSession(userId: string, draftData?: DmSessionDraftData | null): Promise<DmSessionRecord> {
  const timestamp = nowIso();
  return getRepos().dmSessions.create({
    sessionId: uuidv4(),
    userId,
    sessionType: 'knowledge_draft',
    draftData: draftData ?? null,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

export function isOrganizeStartText(text: string): boolean {
  return isOrganizeStart(text);
}

export async function createKnowledgeDraftSession(userId: string): Promise<DmSessionRecord> {
  return createActiveSession(userId);
}

export function mergeVisionTextWithSessionNotes(
  session: DmSessionRecord,
  visionText: string
): string {
  const priorNotes = session.draftData?.inputNotes?.trim();
  const visionBlock = `[截圖理解]\n${visionText.trim()}`;
  return priorNotes ? `${priorNotes}\n\n${visionBlock}` : visionBlock;
}

export async function integrateDraftContent(
  userId: string,
  session: DmSessionRecord,
  content: string,
  operation: 'create' | 'supplement' | 'modify',
  inputNotes?: string
): Promise<BotReply[]> {
  return processContentIntoDraft(userId, session, content, operation, inputNotes);
}

async function applyDraftResult(
  userId: string,
  session: DmSessionRecord,
  result: Awaited<ReturnType<typeof generateKnowledgeCardDraft>>,
  inputNotes?: string
): Promise<BotReply[]> {
  const isAdmin = await isActiveAdmin(userId);
  const signature = validationSignature(result);
  const priorSignature = session.draftData?.lastValidationSignature;
  const repeatFailure =
    result.kind === 'single_card' &&
    !result.validation.valid &&
    Boolean(priorSignature) &&
    priorSignature === signature;

  if (result.kind === 'single_card' && result.validation.valid && result.validation.normalized) {
    const draftText = formatDraftReply(result, { isAdmin });
    const draftData = buildDraftDataFromResult(
      result.validation.normalized,
      result.draftJson ?? JSON.stringify(result.validation.normalized, null, 2),
      draftText,
      inputNotes ?? session.draftData?.inputNotes
    );
    await getRepos().dmSessions.updateDraftData(session.sessionId, draftData, nowIso());
  } else if (result.kind === 'single_card') {
    const failureReason = formatValidationErrorsForHuman(result.validation.errors);
    const attemptedCard = result.attemptedCard ?? session.draftData?.lastInvalidDraft ?? session.draftData?.card;
    const draftText = formatDraftReply(result, { isAdmin, repeatValidationFailure: repeatFailure });
    const draftData: DmSessionDraftData = {
      draftText,
      humanReadableDraft: draftText,
      inputNotes: inputNotes ?? session.draftData?.inputNotes,
      card: undefined,
      draftJson: result.draftJson ?? session.draftData?.draftJson ?? null,
      validationStatus: 'failed',
      validationFailureReason: failureReason,
      lastInvalidDraft: attemptedCard ?? undefined,
      lastValidationSignature: signature || priorSignature,
      validationFailureCount: repeatFailure
        ? (session.draftData?.validationFailureCount ?? 1) + 1
        : 1,
    };
    await getRepos().dmSessions.updateDraftData(session.sessionId, draftData, nowIso());
  }

  suppressPrivateFallbackForUser(userId);
  return pushReply(
    userId,
    result.kind === 'single_card'
      ? formatDraftReply(result, { isAdmin, repeatValidationFailure: repeatFailure })
      : formatDraftReply(result)
  );
}

async function processContentIntoDraft(
  userId: string,
  session: DmSessionRecord,
  content: string,
  operation: 'create' | 'supplement' | 'modify' = 'create',
  inputNotes?: string
): Promise<BotReply[]> {
  if (operation === 'create' && !hasMinimumDraftInput(content)) {
    return pushReply(userId, INSUFFICIENT_DRAFT_INPUT_MESSAGE);
  }

  const existingCard =
    session.draftData?.card ??
    session.draftData?.lastInvalidDraft ??
    null;
  const result = await generateKnowledgeCardDraft({
    operation,
    consultantRequest: content,
    existingCard,
  });

  return applyDraftResult(
    userId,
    session,
    result,
    inputNotes ?? session.draftData?.inputNotes
  );
}

async function handleOrganizeFromHandoff(ctx: DmSessionMessageContext): Promise<BotReply[]> {
  const context = consumeHandoffReplyContext(ctx.userId);
  if (!context) {
    return pushReply(
      ctx.userId,
      '目前沒有可整理的代回內容。請先完成代回群組，或輸入「幫我整理知識卡」手動整理。'
    );
  }

  const existing = await getActiveSession(ctx.userId);
  if (existing) {
    return pushReply(ctx.userId, EXISTING_SESSION_PROMPT);
  }

  const session = await createActiveSession(ctx.userId);
  return processContentIntoDraft(
    ctx.userId,
    session,
    buildOrganizeContentFromHandoff(context),
    'create'
  );
}

async function handleStartOrganize(ctx: DmSessionMessageContext): Promise<BotReply[]> {
  if (!(await isActiveConsultantOrAdmin(ctx.userId))) {
    return pushReply(ctx.userId, INACTIVE_DRAFT_MESSAGE);
  }

  const existing = await getActiveSession(ctx.userId);
  if (existing) {
    return pushReply(ctx.userId, EXISTING_SESSION_PROMPT);
  }

  const content = extractOrganizeContent(ctx.text);
  if (isBareOrganizeStart(ctx.text) || content.length === 0) {
    await createActiveSession(ctx.userId);
    resetPrivateFallbackForUser(ctx.userId);
    return pushReply(ctx.userId, START_CONTENT_PROMPT);
  }

  const session = await createActiveSession(ctx.userId);
  return processContentIntoDraft(ctx.userId, session, content, 'create');
}

async function handleSupplement(ctx: DmSessionMessageContext): Promise<BotReply[]> {
  const session = await getActiveSession(ctx.userId);
  if (!session) {
    suppressPrivateFallbackForUser(ctx.userId);
    return pushReply(ctx.userId, NO_ACTIVE_DRAFT_SESSION_MESSAGE);
  }
  const payload = ctx.text.replace(SUPPLEMENT_PATTERN, '').trim();
  if (!payload) {
    return pushReply(ctx.userId, '請在「補充：」後提供內容。');
  }
  return processContentIntoDraft(ctx.userId, session, payload, 'supplement');
}

async function handleModify(ctx: DmSessionMessageContext): Promise<BotReply[]> {
  const session = await getActiveSession(ctx.userId);
  if (!session) {
    suppressPrivateFallbackForUser(ctx.userId);
    return pushReply(ctx.userId, NO_ACTIVE_DRAFT_SESSION_MESSAGE);
  }
  const payload = ctx.text.replace(MODIFY_PATTERN, '').trim();
  if (!payload) {
    return pushReply(ctx.userId, '請在「修改：」後提供內容。');
  }
  return processContentIntoDraft(ctx.userId, session, payload, 'modify');
}

async function handleRegenerate(ctx: DmSessionMessageContext): Promise<BotReply[]> {
  const session = await getActiveSession(ctx.userId);
  const card = session?.draftData?.card ?? session?.draftData?.lastInvalidDraft;
  if (!session || !card) {
    return pushReply(ctx.userId, '目前沒有可重新整理的草稿內容，請先提供知識卡內容。');
  }
  const isAdmin = await isActiveAdmin(ctx.userId);
  const humanReadable = formatHumanReadableKnowledgeCard(card, { isAdmin });
  const draftData: DmSessionDraftData = {
    ...session.draftData,
    humanReadableDraft: humanReadable,
    draftText: humanReadable,
  };
  await getRepos().dmSessions.updateDraftData(session.sessionId, draftData, nowIso());
  resetPrivateFallbackForUser(ctx.userId);
  return pushReply(ctx.userId, humanReadable);
}

async function handleExportJson(ctx: DmSessionMessageContext): Promise<BotReply[]> {
  const session = await getActiveSession(ctx.userId);
  const card = session?.draftData?.card ?? session?.draftData?.lastInvalidDraft;
  if (!session || !card) {
    suppressPrivateFallbackForUser(ctx.userId);
    return pushReply(ctx.userId, NO_ACTIVE_DRAFT_SESSION_MESSAGE);
  }
  const validation = enforceKnowledgeCardRules(card);
  if (!validation.valid || !validation.normalized) {
    return pushReply(
      ctx.userId,
      ['【驗證失敗】無法轉成 JSON：', formatValidationErrorsForHuman(validation.errors)].join('\n')
    );
  }
  await getRepos().dmSessions.updateDraftData(
    session.sessionId,
    {
      draftText: session.draftData?.draftText ?? formatDraftJson(validation.normalized),
      humanReadableDraft: session.draftData?.humanReadableDraft ?? formatDraftJson(validation.normalized),
      ...session.draftData,
      card: validation.normalized,
      draftJson: JSON.stringify(validation.normalized, null, 2),
    },
    nowIso()
  );
  return pushReply(ctx.userId, `【JSON 草稿】\n${formatDraftJson(validation.normalized)}`);
}

async function handleComplete(ctx: DmSessionMessageContext): Promise<BotReply[]> {
  const session = await getActiveSession(ctx.userId);
  if (!session) {
    return pushReply(ctx.userId, '目前沒有進行中的草稿整理。');
  }
  await getRepos().dmSessions.markCompleted(session.sessionId, nowIso());
  resetPrivateFallbackForUser(ctx.userId);
  return pushReply(ctx.userId, '草稿整理已完成，資料已保留。');
}

async function handleCancel(ctx: DmSessionMessageContext): Promise<BotReply[]> {
  const session = await getActiveSession(ctx.userId);
  if (!session) {
    suppressPrivateFallbackForUser(ctx.userId);
    return pushReply(ctx.userId, '目前沒有進行中的草稿整理。');
  }
  await getRepos().dmSessions.markCancelled(session.sessionId, nowIso());
  suppressPrivateFallbackForUser(ctx.userId);
  return pushReply(ctx.userId, '已取消目前知識卡整理流程，草稿資料已保留。');
}

async function handleVisionConfirm(ctx: DmSessionMessageContext): Promise<BotReply[]> {
  const session = await getActiveSession(ctx.userId);
  if (!session?.draftData?.pendingVisionSummary) {
    return pushReply(ctx.userId, '目前沒有待確認的截圖理解摘要。');
  }

  const mergedContent = session.draftData.inputNotes?.trim() ?? session.draftData.pendingVisionSummary;
  const operation = session.draftData.card ? 'supplement' : 'create';
  const draftData: DmSessionDraftData = {
    ...session.draftData,
    pendingVisionSummary: undefined,
  };
  await getRepos().dmSessions.updateDraftData(session.sessionId, draftData, nowIso());
  return integrateDraftContent(ctx.userId, session, mergedContent, operation, mergedContent);
}

async function handleVisionSummaryAdjust(ctx: DmSessionMessageContext): Promise<BotReply[]> {
  const session = await getActiveSession(ctx.userId);
  if (!session?.draftData?.pendingVisionSummary) {
    return pushReply(ctx.userId, '目前沒有待確認的截圖理解摘要。');
  }

  const payload = ctx.text.replace(SUPPLEMENT_PATTERN, '').replace(MODIFY_PATTERN, '').trim();
  if (!payload) {
    return pushReply(ctx.userId, '請在「補充：」或「修改：」後提供內容。');
  }

  const baseVision = session.draftData.pendingVisionSummary;
  const adjustedVision = `${baseVision}\n\n[使用者調整]\n${payload}`;
  const summaryMessage = buildVisionSummaryMessage(adjustedVision);
  const draftData: DmSessionDraftData = {
    ...session.draftData,
    pendingVisionSummary: adjustedVision,
    inputNotes: mergeVisionTextWithSessionNotes(session, adjustedVision),
    draftText: summaryMessage,
    humanReadableDraft: summaryMessage,
  };
  await getRepos().dmSessions.updateDraftData(session.sessionId, draftData, nowIso());
  return pushReply(ctx.userId, summaryMessage);
}

function sessionHasDraftContext(session: DmSessionRecord): boolean {
  return Boolean(
    session.draftData?.card ||
      session.draftData?.lastInvalidDraft ||
      session.draftData?.inputNotes?.trim() ||
      session.draftData?.pendingVisionSummary?.trim()
  );
}

function isDraftCommandWithoutSession(text: string): boolean {
  const trimmed = text.trim();
  return (
    SUPPLEMENT_PATTERN.test(trimmed) ||
    MODIFY_PATTERN.test(trimmed) ||
    trimmed === EXPORT_JSON_PHRASE ||
    isConfirmSubmitPhrase(trimmed) ||
    matchesConfirmUpdateCommand(trimmed)
  );
}

async function handleGeneralContent(ctx: DmSessionMessageContext): Promise<BotReply[]> {
  const session = await getActiveSession(ctx.userId);
  if (!session) {
    return [];
  }

  if (session.draftData?.pendingVisionSummary) {
    return pushReply(
      ctx.userId,
      '截圖理解摘要尚未確認。請回覆「對，幫我整理成知識卡」，或使用「補充：…」「修改：…」「取消」。'
    );
  }

  const content = ctx.text.trim();
  const hasContext = sessionHasDraftContext(session);
  if (!hasContext && !hasMinimumDraftInput(content)) {
    return pushReply(ctx.userId, INSUFFICIENT_DRAFT_INPUT_MESSAGE);
  }

  const operation = session.draftData?.card ? 'supplement' : 'create';
  return processContentIntoDraft(ctx.userId, session, content, operation);
}

export async function storeSessionDraftFromRevision(
  userId: string,
  card: KnowledgeCard,
  draftText: string
): Promise<void> {
  const draftData = buildDraftDataFromResult(
    card,
    JSON.stringify(card, null, 2),
    draftText
  );
  const existing = await getActiveSession(userId);
  const updatedAt = nowIso();
  if (existing) {
    await getRepos().dmSessions.updateDraftData(existing.sessionId, draftData, updatedAt);
    return;
  }
  await getRepos().dmSessions.create({
    sessionId: uuidv4(),
    userId,
    sessionType: 'knowledge_draft',
    draftData,
    createdAt: updatedAt,
    updatedAt,
  });
}

export async function markSessionCompleted(userId: string): Promise<void> {
  const session = await getActiveSession(userId);
  if (session) {
    await getRepos().dmSessions.markCompleted(session.sessionId, nowIso());
  }
}

export async function handleDmSessionPrivateMessage(
  ctx: DmSessionMessageContext
): Promise<BotReply[] | null> {
  const trimmed = ctx.text.trim();

  if (isOrganizeStart(trimmed)) {
    return handleStartOrganize(ctx);
  }

  if (isOrganizeFromHandoffPhrase(trimmed)) {
    return handleOrganizeFromHandoff(ctx);
  }

  if (!(await isActiveConsultantOrAdmin(ctx.userId))) {
    return null;
  }

  const expiredReplies = await expireStaleSessionIfNeeded(ctx.userId);
  if (expiredReplies) {
    return expiredReplies;
  }

  if (trimmed === EXPORT_JSON_PHRASE) {
    return handleExportJson(ctx);
  }

  if (trimmed === REGENERATE_PHRASE) {
    return handleRegenerate(ctx);
  }

  if (trimmed === COMPLETE_PHRASE) {
    return handleComplete(ctx);
  }

  if (isCancelPhrase(trimmed)) {
    return handleCancel(ctx);
  }

  if (isConfirmSubmitPhrase(trimmed)) {
    return handleConsultantConfirmSubmit(ctx.userId);
  }

  if (matchesConfirmUpdateCommand(trimmed)) {
    return handleConsultantConfirmUpdateAttempt({
      userId: ctx.userId,
      text: trimmed,
      quotedMessageId: ctx.quotedMessageId,
    });
  }

  if (isViewPendingHandoffsPhrase(trimmed)) {
    return handleViewPendingHandoffs(ctx.userId);
  }

  if (isVisionConfirmPhrase(trimmed)) {
    return handleVisionConfirm(ctx);
  }

  if (SUPPLEMENT_PATTERN.test(trimmed) || MODIFY_PATTERN.test(trimmed)) {
    const activeSession = await getActiveSession(ctx.userId);
    if (activeSession?.draftData?.pendingVisionSummary) {
      return handleVisionSummaryAdjust(ctx);
    }
  }

  if (SUPPLEMENT_PATTERN.test(trimmed)) {
    return handleSupplement(ctx);
  }

  if (MODIFY_PATTERN.test(trimmed)) {
    return handleModify(ctx);
  }

  const activeSession = await getActiveSession(ctx.userId);
  if (!activeSession) {
    if (isDraftCommandWithoutSession(trimmed)) {
      suppressPrivateFallbackForUser(ctx.userId);
      return pushReply(ctx.userId, NO_ACTIVE_DRAFT_SESSION_MESSAGE);
    }
    return null;
  }

  if (isAmbiguousAck(trimmed)) {
    return pushReply(ctx.userId, AMBIGUOUS_ACTIVE_SESSION_HINT);
  }

  if (isOrganizeStart(trimmed)) {
    return pushReply(ctx.userId, EXISTING_SESSION_PROMPT);
  }

  const contentReplies = await handleGeneralContent(ctx);
  if (contentReplies.length > 0) {
    const insufficient = contentReplies[0].text === INSUFFICIENT_DRAFT_INPUT_MESSAGE;
    if (insufficient) {
      return contentReplies;
    }
    return contentReplies;
  }

  return pushReply(ctx.userId, UNRELATED_ACTIVE_SESSION_HINT);
}

/** @deprecated 2-B 改用 storeSessionDraft；保留測試過渡 */
export async function storeUserDraft(
  userId: string,
  card: KnowledgeCard,
  draftJson: string,
  draftText: string
): Promise<void> {
  await storeSessionDraft(userId, card, draftJson, draftText);
}

/** @deprecated 2-B 改用 getSessionDraft */
export async function getUserDraft(userId: string): Promise<StoredDraft | undefined> {
  return getSessionDraft(userId);
}

/** @deprecated 2-B 改用 cancel session */
export async function deleteUserDraft(userId: string): Promise<void> {
  const session = await getActiveSession(userId);
  if (session) {
    await getRepos().dmSessions.markCancelled(session.sessionId, nowIso());
  }
}

export async function seedActiveSessionForTest(params: {
  userId: string;
  card?: KnowledgeCard;
  draftText?: string;
  updatedAt?: string;
}): Promise<DmSessionRecord> {
  const updatedAt = params.updatedAt ?? nowIso();
  const draftData: DmSessionDraftData | null = params.card
    ? buildDraftDataFromResult(
        params.card,
        JSON.stringify(params.card, null, 2),
        params.draftText ?? formatHumanReadableKnowledgeCard(params.card)
      )
    : null;
  return getRepos().dmSessions.create({
    sessionId: uuidv4(),
    userId: params.userId,
    sessionType: 'knowledge_draft',
    draftData,
    createdAt: updatedAt,
    updatedAt,
  });
}

export {
  EXISTING_SESSION_PROMPT,
  START_CONTENT_PROMPT,
  EXPIRED_SESSION_MESSAGE,
  INACTIVE_DRAFT_MESSAGE,
};
