import { BotReply } from '../types';
import { isActiveAdmin, isActiveConsultantOrAdmin } from './consultantWhitelist';
import { parseExportCommand, exportKnowledgeCards } from './knowledgeCardExportService';
import {
  executeBulkImport,
  isBulkImportStart,
  isConfirmBulkImportPhrase,
  parseBulkImportPayload,
  previewBulkImport,
} from './knowledgeCardImportService';
import { parseViewCommand, handleViewCommand, parseKnowledgeSearchQuery, handleKnowledgeSearchCommand } from './knowledgeCardViewService';
import {
  handleSnoozeHandoff,
  isSnoozeHandoffPhrase,
} from './pendingHandoffService';
import { isRoundQuietPhrase } from './roundQuietService';
import {
  handleAdminRejectDraft,
  handleAdminEditDraft,
  parseAdminEditDraftCommand,
  handleAdminRevisionFeedback,
  handleConsultantConfirmSubmit,
  handleConsultantConfirmUpdateAttempt,
  isConfirmSubmitPhrase,
  matchesConfirmUpdateCommand,
  parseRevisionFeedback,
  isRejectCommand,
} from './knowledgeCardWriteService';
import {
  handleResumeKnowledgeCard,
  parseResumeKnowledgeCardCommand,
} from './knowledgeCardResumeService';
import { handlePendingReviewQueryCommand } from './knowledgeCardPendingReviewQueryService';

export interface KnowledgeCardCommandContext {
  userId: string;
  text: string;
  quotedMessageId?: string;
}

export async function handleKnowledgeCardCommand(
  ctx: KnowledgeCardCommandContext
): Promise<BotReply[] | null> {
  const trimmed = ctx.text.trim();

  const pendingReviewQuery = await handlePendingReviewQueryCommand(ctx.userId, trimmed);
  if (pendingReviewQuery) {
    return pendingReviewQuery;
  }

  if (isRoundQuietPhrase(trimmed)) {
    if (!(await isActiveConsultantOrAdmin(ctx.userId))) {
      return null;
    }
    return [
      {
        type: 'push',
        userId: ctx.userId,
        text: '「本輪安靜」請在群組內使用，且僅作用於當前進行中的問題 thread。',
      },
    ];
  }

  if (isSnoozeHandoffPhrase(trimmed)) {
    if (!(await isActiveConsultantOrAdmin(ctx.userId))) {
      return null;
    }
    return handleSnoozeHandoff(ctx.userId);
  }

  const searchQuery = parseKnowledgeSearchQuery(trimmed);
  if (searchQuery) {
    const result = await handleKnowledgeSearchCommand(ctx.userId, searchQuery);
    return result;
  }

  if (isConfirmSubmitPhrase(trimmed)) {
    if (!(await isActiveConsultantOrAdmin(ctx.userId))) {
      return null;
    }
    return handleConsultantConfirmSubmit(ctx.userId);
  }

  if (matchesConfirmUpdateCommand(trimmed)) {
    return handleConsultantConfirmUpdateAttempt({
      userId: ctx.userId,
      text: trimmed,
      quotedMessageId: ctx.quotedMessageId,
    });
  }

  if (parseAdminEditDraftCommand(trimmed)) {
    if (!(await isActiveAdmin(ctx.userId))) {
      return [{ type: 'push', userId: ctx.userId, text: '只有 active admin 可編輯待審草稿。' }];
    }
    return handleAdminEditDraft({
      userId: ctx.userId,
      text: trimmed,
      quotedMessageId: ctx.quotedMessageId,
    });
  }

  const revision = parseRevisionFeedback(trimmed);
  if (revision !== null) {
    if (!(await isActiveAdmin(ctx.userId))) {
      return [{ type: 'push', userId: ctx.userId, text: '只有 active admin 可回覆修改意見。' }];
    }
    return handleAdminRevisionFeedback({
      userId: ctx.userId,
      text: trimmed,
      quotedMessageId: ctx.quotedMessageId,
    });
  }

  if (isRejectCommand(trimmed)) {
    if (!(await isActiveAdmin(ctx.userId))) {
      return [{ type: 'push', userId: ctx.userId, text: '只有 active admin 可退回草稿。' }];
    }
    return handleAdminRejectDraft({
      userId: ctx.userId,
      text: trimmed,
      quotedMessageId: ctx.quotedMessageId,
    });
  }

  const resumeTarget = parseResumeKnowledgeCardCommand(trimmed);
  if (resumeTarget) {
    if (!(await isActiveAdmin(ctx.userId))) {
      return [{ type: 'push', userId: ctx.userId, text: '只有 active admin 可恢復知識卡。' }];
    }
    return handleResumeKnowledgeCard(ctx.userId, resumeTarget);
  }

  if (isConfirmBulkImportPhrase(trimmed)) {
    return executeBulkImport(ctx.userId);
  }

  const exportFilter = parseExportCommand(trimmed);
  if (exportFilter) {
    const result = await exportKnowledgeCards(ctx.userId, exportFilter);
    return result.replies;
  }

  const viewCommand = parseViewCommand(trimmed);
  if (viewCommand) {
    return handleViewCommand(ctx.userId, viewCommand);
  }

  if (isBulkImportStart(trimmed)) {
    if (!(await isActiveAdmin(ctx.userId))) {
      return [{ type: 'push', userId: ctx.userId, text: '只有 active admin 可批量匯入。' }];
    }
    const payload = parseBulkImportPayload(trimmed);
    if (payload === null && trimmed === '批量匯入') {
      return [
        {
          type: 'push',
          userId: ctx.userId,
          text: '請在「批量匯入」後貼上 JSON 陣列，例如：批量匯入\\n[{...}]',
        },
      ];
    }
    if (payload) {
      const result = await previewBulkImport(ctx.userId, payload);
      return result.replies;
    }
  }

  return null;
}

export async function canUseKnowledgeCardCommands(userId: string): Promise<boolean> {
  return isActiveConsultantOrAdmin(userId);
}

export async function canUseKnowledgeCardWriteCommands(userId: string): Promise<boolean> {
  return isActiveAdmin(userId);
}
