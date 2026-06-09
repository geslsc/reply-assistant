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

  const card = validation.normalized;
  const now = new Date().toISOString();
  const fields = knowledgeCardToDbFields(card);
  const existing = await getRepos().knowledgeCards.findById(card.card_id);
  const effectiveOperation = existing ? 'update' : 'create';

  if (existing) {
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
