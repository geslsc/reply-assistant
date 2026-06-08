import { BotReply } from '../types';
import { DmSessionRecord } from '../repositories/dmSessionTypes';
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
  hasMinimumDraftInput,
  INSUFFICIENT_DRAFT_INPUT_MESSAGE,
} from './knowledgeCardDraftService';

export interface PrivateImageMessageContext {
  userId: string;
  messageId: string;
  accompanyingText?: string;
}

export const IMAGE_ORGANIZE_FIRST_MESSAGE =
  '如要用截圖整理知識卡，請先輸入「幫我整理知識卡」。';
export const VISION_FAILED_MESSAGE = '截圖理解失敗，請改用文字描述';
export const AI_NOT_ENABLED_MESSAGE = 'AI 功能尚未啟用';

function pushReply(userId: string, text: string): BotReply[] {
  return [{ type: 'push', userId, text }];
}

function isUnclearVisionText(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return true;
  }
  return /看不清|無法辨識|無法看清|畫面空白|完全空白|太模糊/u.test(trimmed);
}

async function processVisionIntoSession(
  userId: string,
  session: DmSessionRecord,
  visionText: string
): Promise<BotReply[]> {
  if (!hasMinimumDraftInput(visionText) || isUnclearVisionText(visionText)) {
    return pushReply(userId, INSUFFICIENT_DRAFT_INPUT_MESSAGE);
  }

  const mergedContent = mergeVisionTextWithSessionNotes(session, visionText);
  const operation = session.draftData?.card ? 'supplement' : 'create';
  return integrateDraftContent(userId, session, mergedContent, operation, mergedContent);
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
  let contentType = 'image/jpeg';
  try {
    const downloaded = await downloadLineMessageImage(ctx.messageId);
    imageBuffer = downloaded.buffer;
    contentType = downloaded.contentType;
    const visionText = await analyzeScreenshotBuffer({
      imageBuffer,
      contentType,
    });
    imageBuffer = null;

    await logScreenshotDraftInput(ctx.userId);

    let session = activeSession;
    if (!session) {
      session = await createKnowledgeDraftSession(ctx.userId);
    }

    return processVisionIntoSession(ctx.userId, session, visionText);
  } catch {
    return pushReply(ctx.userId, VISION_FAILED_MESSAGE);
  } finally {
    imageBuffer = null;
  }
}
