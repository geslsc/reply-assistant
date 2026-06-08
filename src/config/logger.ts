import { getEnv } from './env';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function shouldLog(level: LogLevel): boolean {
  const configured = (getEnv().LOG_LEVEL as LogLevel) || 'info';
  const configuredLevel = LEVELS[configured] ?? LEVELS.info;
  return LEVELS[level] >= configuredLevel;
}

function write(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
  if (!shouldLog(level)) {
    return;
  }
  const payload = meta ? `${message} ${JSON.stringify(meta)}` : message;
  const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${payload}`;
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  debug: (message: string, meta?: Record<string, unknown>) => write('debug', message, meta),
  info: (message: string, meta?: Record<string, unknown>) => write('info', message, meta),
  warn: (message: string, meta?: Record<string, unknown>) => write('warn', message, meta),
  error: (message: string, meta?: Record<string, unknown>) => write('error', message, meta),
};
