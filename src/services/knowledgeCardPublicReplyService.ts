import { KnowledgeCard } from '../schemas/knowledgeCardSchema';
import { RiskLevel } from '../types';
import { PublicReplyPreference } from '../repositories/dmSessionTypes';
import { cardContainsSensitiveContent } from './knowledgeCardValidator';
import { containsHardSensitiveKeyword, removeNegationContexts } from './sensitiveContentClassifier';

export const SET_PUBLIC_REPLY_PHRASES = [
  '設為可公開回答',
  '這張可以公開回答',
  '可以讓小助手回答',
] as const;

export const SET_CONSULTANT_REFERENCE_PHRASES = [
  '設為導入教練參考',
  '這張不要自動回答',
] as const;

export function parsePublicReplyPreferencePhrase(
  text: string
): PublicReplyPreference | null {
  const trimmed = text.trim();
  if (SET_PUBLIC_REPLY_PHRASES.includes(trimmed as (typeof SET_PUBLIC_REPLY_PHRASES)[number])) {
    return 'suggest_public';
  }
  if (
    SET_CONSULTANT_REFERENCE_PHRASES.includes(
      trimmed as (typeof SET_CONSULTANT_REFERENCE_PHRASES)[number]
    )
  ) {
    return 'suggest_consultant';
  }
  return null;
}

export function resolveEffectivePublicReplyPreference(params: {
  preference?: PublicReplyPreference;
  isAdmin: boolean;
}): PublicReplyPreference | undefined {
  if (!params.preference) {
    return undefined;
  }
  if (params.isAdmin) {
    if (params.preference === 'suggest_public' || params.preference === 'admin_public') {
      return 'admin_public';
    }
    if (params.preference === 'suggest_consultant' || params.preference === 'admin_consultant') {
      return 'admin_consultant';
    }
  }
  return params.preference;
}

function containsHardSensitiveBlockingContent(card: Partial<KnowledgeCard>): boolean {
  const combined = [
    card.title,
    ...(card.patterns ?? []),
    card.standard_answer,
  ]
    .filter((value): value is string => typeof value === 'string')
    .join(' ');
  return containsHardSensitiveKeyword(removeNegationContexts(combined));
}

export function applyPublicReplyPreference(
  card: KnowledgeCard,
  preference: PublicReplyPreference | undefined
): KnowledgeCard {
  if (!preference) {
    return card;
  }

  const hardBlocked = containsHardSensitiveBlockingContent(card);

  if (preference === 'admin_public' || preference === 'suggest_public') {
    if (hardBlocked) {
      return card;
    }
    return {
      ...card,
      risk_level: RiskLevel.LOW,
      can_public_reply: true,
    };
  }

  if (preference === 'admin_consultant' || preference === 'suggest_consultant') {
    return {
      ...card,
      risk_level: RiskLevel.MID,
      can_public_reply: false,
    };
  }

  return card;
}

export function buildPublicReplySuggestion(card: KnowledgeCard): {
  label: string;
  reason: string;
  canAdminOverride: boolean;
} {
  const hardBlocked = containsHardSensitiveBlockingContent(card);
  if (hardBlocked) {
    return {
      label: '不建議',
      reason: '內容涉及金額、帳務、權限或資料異常等硬紅線，不得由小助手自動公開回答。',
      canAdminOverride: false,
    };
  }

  if (card.can_public_reply && card.risk_level === RiskLevel.LOW) {
    return {
      label: '建議：可以',
      reason: '這是一般操作教學，未涉及金額異常、權限或資料異常。',
      canAdminOverride: true,
    };
  }

  const sensitive = cardContainsSensitiveContent(card);
  if (sensitive.length > 0) {
    return {
      label: '不建議',
      reason: `內容涉及${sensitive.join('、')}相關情境，建議僅作為導入教練參考。`,
      canAdminOverride: true,
    };
  }

  if (card.risk_level !== RiskLevel.LOW) {
    return {
      label: '不建議',
      reason: '這張卡目前不適合由小助手自動公開回答，建議作為導入教練參考。',
      canAdminOverride: true,
    };
  }

  return {
    label: '建議：可以',
    reason: '未命中帳務/金流/權限/資料異常硬紅線。',
    canAdminOverride: true,
  };
}

export function describeAppliedPublicReplyState(params: {
  card: KnowledgeCard;
  preference?: PublicReplyPreference;
  isAdmin: boolean;
}): string {
  const suggestion = buildPublicReplySuggestion(params.card);
  const effective = resolveEffectivePublicReplyPreference({
    preference: params.preference,
    isAdmin: params.isAdmin,
  });

  const lines = ['小助手是否建議自動公開回答：', suggestion.label, `原因：${suggestion.reason}`];

  if (params.preference === 'suggest_public' && !params.isAdmin) {
    lines.push('（顧問已建議設為可公開回答，需 Admin 確認更新後才生效。）');
  }
  if (params.preference === 'suggest_consultant' && !params.isAdmin) {
    lines.push('（顧問已建議設為導入教練參考，需 Admin 確認更新後才生效。）');
  }
  if (effective === 'admin_public') {
    lines.push('（Admin 已覆核：設為可公開回答，確認更新時仍會跑 validator。）');
  }
  if (effective === 'admin_consultant') {
    lines.push('（Admin 已覆核：設為導入教練參考。）');
  }
  if (
    (effective === 'admin_public' || params.preference === 'suggest_public') &&
    !suggestion.canAdminOverride
  ) {
    lines.push('（此內容命中硬紅線，即使 Admin 覆核也無法設為公開回答。）');
  }

  return lines.join('\n');
}

export function buildConfirmSuccessPublicReplyNote(card: KnowledgeCard): string {
  if (card.can_public_reply && card.risk_level === RiskLevel.LOW) {
    return '這張卡之後命中時，小助手會依知識卡內容公開回答。';
  }
  return '這張卡僅作為導入教練參考，不會由小助手自動公開回答。';
}
