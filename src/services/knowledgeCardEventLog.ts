import { Actor, EventType } from '../types';
import { createEvent } from './eventLogService';

export type KnowledgeCardWriteOperation = 'create' | 'update' | 'import' | 'pause' | 'resume';

export async function logKnowledgeCardWrite(params: {
  cardId: string;
  operation: KnowledgeCardWriteOperation;
  operatorUserId: string;
  summary: string;
  timestamp?: string;
  reviewShortCode?: string;
}): Promise<void> {
  const timestamp = params.timestamp ?? new Date().toISOString();
  const detailParts = [
    `operation=${params.operation}`,
    `card_id=${params.cardId}`,
    `operator=${params.operatorUserId}`,
    `timestamp=${timestamp}`,
    `summary=${params.summary}`,
  ];
  if (params.reviewShortCode) {
    detailParts.push(`review_short_code=${params.reviewShortCode}`);
  }
  await createEvent({
    event_type: EventType.CONSULTANT_OVERRIDE,
    actor: Actor.CONSULTANT,
    actor_user_id: params.operatorUserId,
    knowledge_card_id: params.cardId,
    detail: detailParts.join(';'),
    timestamp,
  });
}

export async function logScreenshotDraftInput(operatorUserId: string): Promise<void> {
  await createEvent({
    event_type: EventType.CONSULTANT_OVERRIDE,
    actor: Actor.CONSULTANT,
    actor_user_id: operatorUserId,
    detail: 'input_type=image',
  });
}

export async function logKnowledgeCardValidationFailure(params: {
  cardId: string;
  operation: string;
  operatorUserId: string;
  reasons: string[];
  timestamp?: string;
}): Promise<void> {
  const timestamp = params.timestamp ?? new Date().toISOString();
  const reasonText = params.reasons.join('; ');
  await createEvent({
    event_type: EventType.CONSULTANT_OVERRIDE,
    actor: Actor.CONSULTANT,
    actor_user_id: params.operatorUserId,
    knowledge_card_id: params.cardId,
    detail: [
      `operation=${params.operation}`,
      `card_id=${params.cardId}`,
      `operator=${params.operatorUserId}`,
      `timestamp=${timestamp}`,
      `result=validation_failed`,
      `reason=${reasonText}`,
    ].join(';'),
    timestamp,
  });
}
