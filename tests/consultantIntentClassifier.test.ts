import { loadEnv, resetEnvCache } from '../src/config/env';
import {
  classifyConsultantIntent,
  ConsultantIntent,
  isNannyPeriodPhrase,
  requiresConfirmation,
} from '../src/services/consultantIntentClassifier';

describe('Consultant Intent Classifier', () => {
  beforeEach(() => {
    resetEnvCache();
    loadEnv({ USE_MEMORY_REPOS: true, ENABLE_GROUP_PROXY_REPLY: false });
  });

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

  it('does not classify group proxy reply when disabled', () => {
    expect(classifyConsultantIntent('Q-20260608-0133-A7 請先清除快取').intent).toBe(
      ConsultantIntent.UNKNOWN
    );
    expect(classifyConsultantIntent('代回群組：測試').intent).toBe(ConsultantIntent.UNKNOWN);
    expect(requiresConfirmation(ConsultantIntent.REPLY_TO_GROUP)).toBe(false);
  });

  it('requires confirmation for high impact intents', () => {
    expect(requiresConfirmation(ConsultantIntent.PAUSE_KNOWLEDGE_CARD)).toBe(true);
    expect(requiresConfirmation(ConsultantIntent.PAUSE_ASSISTANT)).toBe(false);
  });
});

describe('Consultant Intent Classifier with group proxy env true', () => {
  beforeEach(() => {
    resetEnvCache();
    loadEnv({ USE_MEMORY_REPOS: true, ENABLE_GROUP_PROXY_REPLY: true });
  });

  it('keeps REPLY_TO_GROUP confirmation disabled even when env is true', () => {
    expect(requiresConfirmation(ConsultantIntent.REPLY_TO_GROUP)).toBe(false);
  });

  it('does not classify short code reply-to-group syntax even when env is true', () => {
    const result = classifyConsultantIntent('Q-20260608-0133-A7 請先清除快取');
    expect(result.intent).toBe(ConsultantIntent.UNKNOWN);
  });
});
