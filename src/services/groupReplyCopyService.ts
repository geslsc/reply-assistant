/** 群組回覆固定話術（不可經 LLM 改寫） */

export const GROUP_FIRST_INTRO_MESSAGE = `老師好，我是客立樂教學小助手 🙂

接下來 30 天，我會和導入教練一起在這個群組協助您處理操作使用上的問題。

遇到基本的操作使用問題時，可以直接在群組用文字描述，例如：

「我的預約服務網站從哪邊設定？」
「我的服務項目跟價格要在哪裡新增或調整？」
「客人預約時可以選的服務要去哪裡開？」
「店內基本資料、地址或 logo 要在哪裡修改？」
「畫面出現錯誤訊息」

我會先協助整理問題，並提供可以參考的操作教學步驟。

如果遇到我還無法判斷，或需要導入教練協助確認的問題，我也會先幫您把狀況整理好，請教練忙完後再回覆您唷！`;

export const GROUP_FOLLOWUP_INTRO_MESSAGE = `我是客立樂教學小助手，主要是協助導入教練一起陪您處理剛開始使用系統時遇到的操作問題唷 🙂

您可以直接把想操作的功能、遇到的畫面，或目前卡住的地方描述給我。

例如可以問我：

「我的預約服務網站從哪邊設定？」
「我的服務項目跟價格要在哪裡新增或調整？」
「客人預約時可以選的服務要去哪裡開？」
「店內基本資料、地址或 logo 要在哪裡修改？」
「畫面出現錯誤訊息」

如果問題需要導入教練協助確認，我也會先幫您整理起來，再請教練協助回覆。`;

export const CUSTOMER_HANDOFF_BUFFER_MESSAGE = `這個問題我先幫您記錄下來，會再請導入教練協助確認。

教練可能正在教學、服務其他老師，或目前不在可回覆時間內，後續會由教練於可協助時再回覆您唷。`;

export const CUSTOMER_OPERATION_STUCK_HANDOFF_MESSAGE = `我先幫您把目前的狀況記錄下來，這題會再請導入教練協助確認。

如果方便的話，也可以補充您目前停在哪個畫面，或貼上畫面截圖，讓教練後續更好判斷問題。`;

export const PUBLIC_REPLY_SUFFIX = `老師可以先照上面的步驟操作看看 🙂

如果畫面跟說明不太一樣，或做到某一步卡住，直接跟我說目前停在哪裡，我會再幫您整理狀況，必要時請導入教練協助確認。`;

export const CHITCHAT_REDIRECT_POOL: readonly string[] = [
  `不過我主要還是客立樂教學小助手，會協助老師處理系統操作上的問題。
如果有預約設定、服務項目、店家資料或畫面卡住的地方，都可以直接描述給我唷！`,
  `但我最主要的任務，還是協助老師解決客立樂使用上的操作問題。
像是預約設定、服務項目調整、店家資料修改，或畫面出現異常，都可以直接問我。`,
  `話題先不聊太遠，我主要是協助客立樂操作問題的小助手 🙂
老師如果有系統設定或操作流程卡住的地方，可以直接把狀況丟給我。`,
  `我會優先協助客立樂系統使用上的問題唷。
如果老師遇到設定、預約、服務項目或畫面操作問題，可以直接描述目前卡在哪裡。`,
  `我主要會協助導入教練，一起處理客立樂操作使用上的問題。
老師有遇到系統設定、預約流程或畫面錯誤，都可以直接告訴我。`,
  `不過我的主要工作還是協助老師整理客立樂操作問題。
如果有哪個功能不知道怎麼設定，或畫面操作跟預期不一樣，可以直接描述給我。`,
  `我還是會把重點放在客立樂系統操作協助上唷 🙂
老師如果遇到預約、服務、店家資料或設定相關問題，都可以直接問我。`,
  `我比較擅長的是協助老師釐清客立樂操作問題。
如果有功能設定、預約流程、服務項目或畫面錯誤的狀況，可以直接跟我說。`,
] as const;

const OPERATION_STUCK_PATTERNS: RegExp[] = [
  /還是不行/u,
  /畫面.*(跟|和).*(你|您)?說.*不一樣/u,
  /跟你說的不一樣/u,
  /跟您說的不一樣/u,
  /找不到按鈕/u,
  /找不到.*按鈕/u,
  /卡在第?[\d一二三四五六七八九十]+步/u,
  /做到.*步.*卡/u,
  /操作.*卡/u,
  /卡住了/u,
];

const FORBIDDEN_HANDOFF_PHRASES = [/請稍等/u, /馬上/u, /等等回覆/u];

const INTRO_FOLLOWUP_PATTERNS: RegExp[] = [
  /^你是誰[？?]?$/u,
  /^你是誰啊[？?]?$/u,
  /可以幹嘛/u,
  /可以幹什麼/u,
  /你會做什麼/u,
  /你會幹嘛/u,
  /使用說明/u,
  /介紹一下/u,
  /可以聊天嗎/u,
  /可以聊天/u,
];

const FIRST_INTRO_TRIGGER_PATTERNS: RegExp[] = [
  /^小助手自我介紹一下$/u,
  /^小助手使用說明$/u,
];

export function isFirstIntroTrigger(text: string): boolean {
  const trimmed = text.trim();
  return FIRST_INTRO_TRIGGER_PATTERNS.some((pattern) => pattern.test(trimmed));
}

export function isIntroFollowUpQuestion(text: string): boolean {
  const trimmed = text.trim();
  if (isFirstIntroTrigger(trimmed)) {
    return true;
  }
  return INTRO_FOLLOWUP_PATTERNS.some((pattern) => pattern.test(trimmed));
}

export function resolveHandoffCustomerMessage(question: string): string {
  if (OPERATION_STUCK_PATTERNS.some((pattern) => pattern.test(question))) {
    return CUSTOMER_OPERATION_STUCK_HANDOFF_MESSAGE;
  }
  return CUSTOMER_HANDOFF_BUFFER_MESSAGE;
}

export function assertHandoffCopyCompliance(message: string): void {
  for (const pattern of FORBIDDEN_HANDOFF_PHRASES) {
    if (pattern.test(message)) {
      throw new Error(`Handoff copy must not contain forbidden phrase: ${pattern}`);
    }
  }
}

export function getChitchatRedirectByIndex(index: number): string {
  const normalized = Number(index);
  if (!Number.isInteger(normalized) || normalized < 1 || normalized > CHITCHAT_REDIRECT_POOL.length) {
    return CHITCHAT_REDIRECT_POOL[0];
  }
  return CHITCHAT_REDIRECT_POOL[normalized - 1];
}

export function pickDeterministicChitchatRedirectIndex(text: string): number {
  let hash = 0;
  for (const char of text) {
    hash = (hash + char.charCodeAt(0)) % CHITCHAT_REDIRECT_POOL.length;
  }
  return hash + 1;
}
