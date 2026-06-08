import { getEnv } from '../config/env';

export const SCREENSHOT_VISION_SYSTEM_PROMPT = [
  '你是客立樂教學小助手的截圖理解助手。',
  '請描述截圖中看到的內容：畫面類型、出現的功能區、文字、按鈕、店家問題、顧問回覆。',
  '看不清楚的內容請直接說看不清，不要猜測或腦補。',
  '不要生成給店家的操作答案，只做內容描述與整理。',
  '如果截圖包含敏感資訊（電話、金額、姓名、身分證、訂單號），請標註「包含敏感資訊」但不要逐字複述敏感內容。',
].join('\n');

const OPENAI_VISION_TIMEOUT_MS = 30_000;

export interface VisionAnalyzeParams {
  imageBuffer: Buffer;
  contentType: string;
}

export interface VisionClient {
  analyzeScreenshot(params: VisionAnalyzeParams): Promise<string>;
}

function bufferToDataUrl(buffer: Buffer, contentType: string): string {
  return `data:${contentType};base64,${buffer.toString('base64')}`;
}

export function createOpenAiVisionClient(apiKey: string, model?: string): VisionClient {
  const visionModel = model ?? getEnv().OPENAI_VISION_MODEL;
  return {
    async analyzeScreenshot(params: VisionAnalyzeParams): Promise<string> {
      const dataUrl = bufferToDataUrl(params.imageBuffer, params.contentType);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), OPENAI_VISION_TIMEOUT_MS);
      try {
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          signal: controller.signal,
          body: JSON.stringify({
            model: visionModel,
            temperature: 0,
            max_tokens: 1200,
            messages: [
              { role: 'system', content: SCREENSHOT_VISION_SYSTEM_PROMPT },
              {
                role: 'user',
                content: [
                  { type: 'text', text: '請描述這張截圖內容。' },
                  { type: 'image_url', image_url: { url: dataUrl } },
                ],
              },
            ],
          }),
        });
        if (!response.ok) {
          const body = await response.text();
          throw new Error(`OpenAI vision API error ${response.status}: ${body}`);
        }
        const data = (await response.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        const content = data.choices?.[0]?.message?.content?.trim();
        if (!content) {
          throw new Error('OpenAI vision API returned empty content');
        }
        return content;
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

let visionClient: VisionClient | null = null;

export function setVisionClient(client: VisionClient | null): void {
  visionClient = client;
}

export function getVisionClient(): VisionClient | null {
  return visionClient;
}

export function initScreenshotVisionClient(): void {
  const apiKey = getEnv().OPENAI_API_KEY;
  if (!apiKey) {
    setVisionClient(null);
    return;
  }
  setVisionClient(createOpenAiVisionClient(apiKey));
}

export function isScreenshotVisionEnabled(): boolean {
  return Boolean(getEnv().OPENAI_API_KEY && getVisionClient());
}

export async function analyzeScreenshotBuffer(params: VisionAnalyzeParams): Promise<string> {
  const client = getVisionClient();
  if (!client) {
    throw new Error('VISION_NOT_ENABLED');
  }
  return client.analyzeScreenshot(params);
}
