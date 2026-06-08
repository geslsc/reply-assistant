export interface AppEnv {
  NODE_ENV: string;
  PORT: number;
  DATABASE_URL: string | null;
  LINE_CHANNEL_SECRET: string | null;
  LINE_CHANNEL_ACCESS_TOKEN: string | null;
  LINE_BOT_BASIC_ID: string | null;
  ADMIN_LINE_USER_IDS: string[];
  CONSULTANT_INVITE_CODE: string | null;
  OFFICIAL_CS_NAME: string | null;
  OFFICIAL_CS_PHONE: string | null;
  OFFICIAL_CS_LINE: string | null;
  OFFICIAL_CS_FORM_URL: string | null;
  OFFICIAL_CS_SERVICE_HOURS: string | null;
  LOG_LEVEL: string;
  USE_MEMORY_REPOS: boolean;
}

let cachedEnv: AppEnv | null = null;

export function loadEnv(overrides: Partial<AppEnv> = {}): AppEnv {
  cachedEnv = {
    NODE_ENV: overrides.NODE_ENV ?? process.env.NODE_ENV ?? 'development',
    PORT: overrides.PORT ?? Number(process.env.PORT ?? 3000),
    DATABASE_URL: overrides.DATABASE_URL ?? process.env.DATABASE_URL ?? null,
    LINE_CHANNEL_SECRET: overrides.LINE_CHANNEL_SECRET ?? process.env.LINE_CHANNEL_SECRET ?? null,
    LINE_CHANNEL_ACCESS_TOKEN:
      overrides.LINE_CHANNEL_ACCESS_TOKEN ?? process.env.LINE_CHANNEL_ACCESS_TOKEN ?? null,
    LINE_BOT_BASIC_ID: overrides.LINE_BOT_BASIC_ID ?? process.env.LINE_BOT_BASIC_ID ?? null,
    ADMIN_LINE_USER_IDS:
      overrides.ADMIN_LINE_USER_IDS ??
      (process.env.ADMIN_LINE_USER_IDS ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    CONSULTANT_INVITE_CODE:
      overrides.CONSULTANT_INVITE_CODE ?? process.env.CONSULTANT_INVITE_CODE ?? null,
    OFFICIAL_CS_NAME: overrides.OFFICIAL_CS_NAME ?? process.env.OFFICIAL_CS_NAME ?? null,
    OFFICIAL_CS_PHONE: overrides.OFFICIAL_CS_PHONE ?? process.env.OFFICIAL_CS_PHONE ?? null,
    OFFICIAL_CS_LINE: overrides.OFFICIAL_CS_LINE ?? process.env.OFFICIAL_CS_LINE ?? null,
    OFFICIAL_CS_FORM_URL:
      overrides.OFFICIAL_CS_FORM_URL ??
      process.env.OFFICIAL_CS_FORM_URL ??
      process.env.OFFICIAL_CS_URL ??
      null,
    OFFICIAL_CS_SERVICE_HOURS:
      overrides.OFFICIAL_CS_SERVICE_HOURS ?? process.env.OFFICIAL_CS_SERVICE_HOURS ?? null,
    LOG_LEVEL: overrides.LOG_LEVEL ?? process.env.LOG_LEVEL ?? 'info',
    USE_MEMORY_REPOS:
      overrides.USE_MEMORY_REPOS ??
      (process.env.USE_MEMORY_REPOS === 'true' || process.env.NODE_ENV === 'test'),
  };
  return cachedEnv;
}

export function getEnv(): AppEnv {
  if (!cachedEnv) {
    return loadEnv();
  }
  return cachedEnv;
}

export function resetEnvCache(): void {
  cachedEnv = null;
}

export function getRepositoryMode(): 'memory' | 'postgres' {
  const env = getEnv();
  if (env.USE_MEMORY_REPOS || env.NODE_ENV === 'test') {
    return 'memory';
  }
  if (env.DATABASE_URL) {
    return 'postgres';
  }
  if (env.NODE_ENV === 'production') {
    throw new Error('DATABASE_URL is required in production');
  }
  return 'memory';
}
