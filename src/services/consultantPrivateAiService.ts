import { getLlmClient } from './knowledgeCardDraftService';

const SUMMARIZE_SYSTEM_PROMPT = `你是客立樂教學小助手的顧問私訊助理。
只在顧問明確要求摘要或整理問題時回應。
回覆給顧問私訊，不得生成可直接公開回群組的操作答案。
不得改寫或代擬顧問代回群組的內容。
以簡潔條列摘要問題重點、可能原因、建議向店家確認的項目。`;

export async function summarizeCustomerQuestionForConsultant(params: {
  consultantRequest: string;
  customerQuestion?: string | null;
}): Promise<string> {
  const client = getLlmClient();
  if (!client) {
    return 'AI 草稿整理尚未啟用';
  }

  const userPrompt = [
    `顧問要求：${params.consultantRequest}`,
    params.customerQuestion ? `店家問題：${params.customerQuestion}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const summary = await client.complete(SUMMARIZE_SYSTEM_PROMPT, userPrompt);
  return ['【問題摘要草稿】', '※ 僅供顧問參考，不會自動回群組。', '', summary.trim()].join('\n');
}
