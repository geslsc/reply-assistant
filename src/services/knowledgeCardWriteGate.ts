import { KnowledgeCard } from '../schemas/knowledgeCardSchema';
import { validateKnowledgeCard, ValidationResult } from './knowledgeCardValidator';
import { formatValidationFailureSummary } from './knowledgeCardValidationMessages';
import {
  logKnowledgeCardValidationFailure,
  logKnowledgeCardWrite,
  KnowledgeCardWriteOperation,
} from './knowledgeCardEventLog';
import { getRepos } from '../repositories';
import { knowledgeCardToDbFields } from '../schemas/knowledgeCardDbSchema';
import { refreshKnowledgeCache } from './knowledgeBaseService';
import { allocateUniqueCardId, isPlaceholderCardId } from './knowledgeCardIdService';
import { KnowledgeDraftMode } from './knowledgeCardDraftModeService';

export interface ValidatedWriteResult {
  ok: boolean;
  cardId: string;
  effectiveOperation?: 'create' | 'update';
  error?: string;
  reasons?: string[];
}

export function validateKnowledgeCardForWrite(card: KnowledgeCard): ValidationResult {
  return validateKnowledgeCard(card);
}

export async function writeKnowledgeCardWithValidation(params: {
  card: KnowledgeCard;
  operatorUserId: string;
  operation: KnowledgeCardWriteOperation | 'import';
  summary: string;
  validationOperation?: string;
  reviewShortCode?: string;
  logValidationFailure?: boolean;
  draftMode?: KnowledgeDraftMode;
}): Promise<ValidatedWriteResult> {
  const validation = validateKnowledgeCardForWrite(params.card);
  if (!validation.valid || !validation.normalized) {
    const reasons = validation.errors.map((e) => `${e.field}: ${e.message}`);
    const humanError = formatValidationFailureSummary(validation.errors);
    if (params.logValidationFailure !== false) {
      await logKnowledgeCardValidationFailure({
        cardId: params.card.card_id,
        operation: params.validationOperation ?? params.operation,
        operatorUserId: params.operatorUserId,
        reasons,
      });
    }
    return {
      ok: false,
      cardId: params.card.card_id,
      error: humanError,
      reasons,
    };
  }

  let card = validation.normalized;
  const now = new Date().toISOString();
  const draftMode = params.draftMode ?? (isPlaceholderCardId(card.card_id) ? 'create' : undefined);
  let effectiveOperation: 'create' | 'update';

  if (draftMode === 'update') {
    const existing = await getRepos().knowledgeCards.findById(card.card_id);
    if (!existing) {
      return {
        ok: false,
        cardId: card.card_id,
        error: `找不到要更新的知識卡「${card.card_id}」。`,
      };
    }
    effectiveOperation = 'update';
  } else {
    if (isPlaceholderCardId(card.card_id)) {
      card = { ...card, card_id: await allocateUniqueCardId() };
      effectiveOperation = 'create';
    } else {
      const existing = await getRepos().knowledgeCards.findById(card.card_id);
      if (existing) {
        return {
          ok: false,
          cardId: card.card_id,
          error: `card_id「${card.card_id}」已存在。新增模式不得覆蓋既有知識卡，請改用「修改知識卡 ${card.card_id}」或重新整理草稿。`,
        };
      }
      effectiveOperation = 'create';
    }
  }

  const fields = knowledgeCardToDbFields(card);

  if (effectiveOperation === 'update') {
    await getRepos().knowledgeCards.update(card.card_id, {
      ...fields,
      updatedBy: params.operatorUserId,
      updatedAt: now,
      confirmedBy: params.operatorUserId,
      confirmedAt: now,
    });
  } else {
    await getRepos().knowledgeCards.insert({
      ...fields,
      createdBy: params.operatorUserId,
      createdAt: now,
      updatedBy: null,
      updatedAt: null,
      confirmedBy: params.operatorUserId,
      confirmedAt: now,
    });
  }

  const logOperation: KnowledgeCardWriteOperation =
    params.operation === 'import'
      ? 'import'
      : params.operation === 'resume'
        ? 'resume'
        : (effectiveOperation as KnowledgeCardWriteOperation);

  await logKnowledgeCardWrite({
    cardId: card.card_id,
    operation: logOperation,
    operatorUserId: params.operatorUserId,
    summary: params.summary,
    reviewShortCode: params.reviewShortCode,
  });

  await refreshKnowledgeCache();

  return { ok: true, cardId: card.card_id, effectiveOperation };
}
