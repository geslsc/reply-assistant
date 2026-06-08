import { ConsultantIntent } from './consultantIntentClassifier';

export interface PendingConfirmation {
  intent: ConsultantIntent;
  payload?: string;
  shortCode?: string;
  groupId?: string;
  createdAt: string;
}

const pendingByUser = new Map<string, PendingConfirmation>();

export function setPendingConfirmation(
  userId: string,
  confirmation: Omit<PendingConfirmation, 'createdAt'>
): void {
  pendingByUser.set(userId, { ...confirmation, createdAt: new Date().toISOString() });
}

export function getPendingConfirmation(userId: string): PendingConfirmation | undefined {
  return pendingByUser.get(userId);
}

export function clearPendingConfirmation(userId: string): void {
  pendingByUser.delete(userId);
}

export function isConfirmationPhrase(text: string): boolean {
  const trimmed = text.trim();
  return trimmed === '確認' || trimmed === '確認執行' || trimmed === '確認代回';
}

export function clearAllPendingConfirmations(): void {
  pendingByUser.clear();
}
