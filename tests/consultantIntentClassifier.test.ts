import {
  classifyConsultantIntent,
  ConsultantIntent,
  isNannyPeriodPhrase,
  requiresConfirmation,
} from '../src/services/consultantIntentClassifier';

describe('Consultant Intent Classifier', () => {
  it('classifies direct execute intents from natural language', () => {
    expect(classifyConsultantIntent('自我介紹一下').intent).toBe(ConsultantIntent.SELF_INTRO);
    expect(classifyConsultantIntent('請店家補充一下').intent).toBe(
      ConsultantIntent.REQUEST_CUSTOMER_INFO
    );
    expect(classifyConsultantIntent('小助手暫停').intent).toBe(ConsultantIntent.PAUSE_ASSISTANT);
    expect(classifyConsultantIntent('恢復小助手').intent).toBe(ConsultantIntent.RESUME_ASSISTANT);
  });

  it('only accepts standard phrases for nanny period', () => {
    expect(isNannyPeriodPhrase('小助手啟用保母期 30 天')).toBe(true);
    expect(isNannyPeriodPhrase('幫我啟用保母期')).toBe(false);
    expect(classifyConsultantIntent('小助手開始協助 30 天').intent).toBe(
      ConsultantIntent.ENABLE_NANNY_PERIOD
    );
  });

  it('requires confirmation for high impact intents', () => {
    expect(requiresConfirmation(ConsultantIntent.REPLY_TO_GROUP)).toBe(true);
    expect(requiresConfirmation(ConsultantIntent.PAUSE_KNOWLEDGE_CARD)).toBe(true);
    expect(requiresConfirmation(ConsultantIntent.PAUSE_ASSISTANT)).toBe(false);
  });

  it('extracts short code and payload for reply to group', () => {
    const result = classifyConsultantIntent('Q-20260608-0133-A7 請先清除快取');
    expect(result.intent).toBe(ConsultantIntent.REPLY_TO_GROUP);
    expect(result.shortCode).toBe('Q-20260608-0133-A7');
    expect(result.payload).toBe('請先清除快取');
  });
});
