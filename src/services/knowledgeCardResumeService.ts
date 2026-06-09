import { BotReply, EventType } from '../types';
import { dbRecordToKnowledgeCard } from '../schemas/knowledgeCardDbSchema';
import { KnowledgeCard } from '../schemas/knowledgeCardSchema';
import { getRepos } from '../repositories';
import { isActiveAdmin } from './consultantWhitelist';
import { writeKnowledgeCardWithValidation } from './knowledgeCardWriteGate';
import { isKnowledgeReviewShortCode } from './knowledgeReviewShortCodeService';

export function parseResumeKnowledgeCardCommand(text: string): string | null {
  const match = text.trim().match(/^恢復知識卡\s+(\S+)$/);
  return match ? match[1] : null;
}

export async function resolveKnowledgeCardIdFromReviewShortCode(
  shortCode: string
): Promise<{ cardId: string } | { error: 'not_found' | 'ambiguous' }> {
  const events = await getRepos().events.findByType(EventType.CONSULTANT_OVERRIDE);
  const marker = `review_short_code=${shortCode}`;
  const cardIds = new Set<string>();

  for (const event of events) {
    if (event.detail?.includes(marker) && event.knowledge_card_id) {
      cardIds.add(event.knowledge_card_id);
    }
  }

  if (cardIds.size === 0) {
    return { error: 'not_found' };
  }
  if (cardIds.size > 1) {
    return { error: 'ambiguous' };
  }

  return { cardId: [...cardIds][0]! };
}

export async function handleResumeKnowledgeCard(
  adminUserId: string,
  cardIdOrRef: string
): Promise<BotReply[]> {
  if (!(await isActiveAdmin(adminUserId))) {
    return [{ type: 'push', userId: adminUserId, text: '只有 active admin 可恢復知識卡。' }];
  }

  let cardId = cardIdOrRef;
  if (isKnowledgeReviewShortCode(cardIdOrRef)) {
    const resolved = await resolveKnowledgeCardIdFromReviewShortCode(cardIdOrRef);
    if ('error' in resolved) {
      if (resolved.error === 'not_found') {
        return [{ type: 'push', userId: adminUserId, text: '找不到指定知識卡。' }];
      }
      return [{ type: 'push', userId: adminUserId, text: '短碼無法唯一定位，請重新指定。' }];
    }
    cardId = resolved.cardId;
  }

  const record = await getRepos().knowledgeCards.findById(cardId);
  if (!record) {
    return [{ type: 'push', userId: adminUserId, text: `找不到知識卡「${cardIdOrRef}」。` }];
  }

  if (record.status === 'active') {
    return [{ type: 'push', userId: adminUserId, text: `知識卡「${cardId}」已是 active。` }];
  }

  const card: KnowledgeCard = { ...dbRecordToKnowledgeCard(record), status: '可用' };
  const result = await writeKnowledgeCardWithValidation({
    card,
    operatorUserId: adminUserId,
    operation: 'resume',
    summary: 'resume knowledge card',
    validationOperation: 'resume',
    draftMode: 'update',
  });

  if (!result.ok) {
    return [
      {
        type: 'push',
        userId: adminUserId,
        text: `知識卡「${cardId}」恢復失敗，未更新 status。\n原因：${result.error}`,
      },
    ];
  }

  return [
    {
      type: 'push',
      userId: adminUserId,
      text: `已恢復知識卡「${cardId}」為 active，並記錄 event_log。`,
    },
  ];
}
