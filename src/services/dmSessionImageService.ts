import { BotReply } from '../types';
import { DmSessionDraftData, DmSessionRecord } from '../repositories/dmSessionTypes';
import { getRepos } from '../repositories';
import { isAiDraftEnabled } from './openaiClient';
import { downloadLineMessageImage } from './lineImageContentService';
import {
  analyzeScreenshotBuffer,
  isScreenshotVisionEnabled,
} from './screenshotVisionService';
import { logScreenshotDraftInput } from './knowledgeCardEventLog';
import { isActiveConsultantOrAdmin } from './consultantWhitelist';
import {
  expireStaleSessionIfNeeded,
  getActiveSession,
  integrateDraftContent,
  createKnowledgeDraftSession,
  mergeVisionTextWithSessionNotes,
  isOrganizeStartText,
} from './dmSessionService';
import {
  buildVisionSummaryMessage,
  isUnclearVisionText,
} from './screenshotVisionSummaryService';

export interface PrivateImageMessageContext {
  userId: string;
  messageId: string;
  accompanyingText?: string;
}

export const IMAGE_ORGANIZE_FIRST_MESSAGE =
  '如要用截圖整理知識卡，請先輸入「幫我整理知識卡」。';
export const VISION_FAILED_MESSAGE = '截圖理解失敗，請改用文字描述';
export const VISION_UNCLEAR_MESSAGE =
  '截圖內容不太清楚，請補充文字說明或重新上傳較清楚的截圖。';
export const AI_NOT_ENABLED_MESSAGE = 'AI 功能尚未啟用';

function pushReply(userId: string, text: string): BotReply[] {
  return [{ type: 'push', userId, text }];
}

function nowIso(): string {
  return new Date().toISOString();
}

async function storePendingVisionSummary(
  userId: string,
  session: DmSessionRecord,
  visionText: string,
  summaryMessage: string
): Promise<BotReply[]> {
  const inputNotes = mergeVisionTextWithSessionNotes(session, visionText);
  const draftData: DmSessionDraftData = {
    draftText: summaryMessage,
    humanReadableDraft: summaryMessage,
    ...(session.draftData ?? {}),
    inputNotes,
    pendingVisionSummary: visionText.trim(),
  };
  await getRepos().dmSessions.updateDraftData(session.sessionId, draftData, nowIso());
  return pushReply(userId, summaryMessage);
}

export async function handlePrivateImageMessage(
  ctx: PrivateImageMessageContext
): Promise<BotReply[]> {
  if (!(await isActiveConsultantOrAdmin(ctx.userId))) {
    return [];
  }

  const expiredReplies = await expireStaleSessionIfNeeded(ctx.userId);
  if (expiredReplies) {
    return expiredReplies;
  }

  const activeSession = await getActiveSession(ctx.userId);
  const organizeTriggered =
    ctx.accompanyingText !== undefined && isOrganizeStartText(ctx.accompanyingText);

  if (!activeSession && !organizeTriggered) {
    return pushReply(ctx.userId, IMAGE_ORGANIZE_FIRST_MESSAGE);
  }

  if (!isAiDraftEnabled() || !isScreenshotVisionEnabled()) {
    return pushReply(ctx.userId, AI_NOT_ENABLED_MESSAGE);
  }

  let imageBuffer: Buffer | null = null;
  try {
    const downloaded = await downloadLineMessageImage(ctx.messageId);
    imageBuffer = downloaded.buffer;
    const visionText = await analyzeScreenshotBuffer({
      imageBuffer,
      contentType: downloaded.contentType,
    });
    imageBuffer = null;

    if (isUnclearVisionText(visionText)) {
      return pushReply(ctx.userId, VISION_UNCLEAR_MESSAGE);
    }

    await logScreenshotDraftInput(ctx.userId);

    let session = activeSession;
    if (!session) {
      session = await createKnowledgeDraftSession(ctx.userId);
    }

    const summaryMessage = buildVisionSummaryMessage(visionText);
    return storePendingVisionSummary(ctx.userId, session, visionText, summaryMessage);
  } catch {
    return pushReply(ctx.userId, VISION_FAILED_MESSAGE);
  } finally {
    imageBuffer = null;
  }
}
