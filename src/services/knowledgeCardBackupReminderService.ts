import { getEnv } from '../config/env';
import { getRepos } from '../repositories';
import { isActiveAdmin } from './consultantWhitelist';

export function getKnowledgeExportReminderDays(): number {
  const raw = process.env.KNOWLEDGE_EXPORT_REMINDER_DAYS;
  if (!raw) {
    return 7;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 7;
}

export async function buildBackupReminderAppend(adminUserId: string): Promise<string | null> {
  if (!(await isActiveAdmin(adminUserId))) {
    return null;
  }

  void getEnv();
  const days = getKnowledgeExportReminderDays();
  const lastExport = await getRepos().consultants.getLastKnowledgeExportAt(adminUserId);

  if (!lastExport) {
    return `提醒：您尚未匯出過知識卡備份，建議輸入「匯出所有知識卡」保存備份。`;
  }

  const elapsedMs = Date.now() - new Date(lastExport).getTime();
  const elapsedDays = Math.floor(elapsedMs / (24 * 60 * 60 * 1000));
  if (elapsedDays < days) {
    return null;
  }

  return `提醒：距離上次匯出知識卡已超過 ${elapsedDays} 天，建議輸入「匯出所有知識卡」保存備份。`;
}

export async function appendBackupReminderIfNeeded(
  adminUserId: string,
  replies: Array<{ type: string; text?: string; userId?: string }>
): Promise<void> {
  const reminder = await buildBackupReminderAppend(adminUserId);
  if (!reminder) {
    return;
  }
  const lastPush = [...replies].reverse().find((r) => r.type === 'push' && r.userId === adminUserId);
  if (lastPush && typeof lastPush.text === 'string') {
    lastPush.text = `${lastPush.text}\n\n${reminder}`;
  }
}
