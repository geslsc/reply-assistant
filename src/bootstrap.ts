import { getEnv } from './config/env';
import { logger } from './config/logger';
import { getRepos, initRepositories } from './repositories';

export async function bootstrapAdmins(): Promise<void> {
  const env = getEnv();
  const repos = getRepos();

  for (const adminId of env.ADMIN_LINE_USER_IDS) {
    await repos.consultants.upsertAdmin(adminId);
    logger.info('Admin upserted from env', { adminId });
  }

  if (env.CONSULTANT_INVITE_CODE && env.ADMIN_LINE_USER_IDS[0]) {
    await repos.consultants.registerInviteCode(
      env.CONSULTANT_INVITE_CODE,
      env.ADMIN_LINE_USER_IDS[0]
    );
  }
}

export async function bootstrapApp(): Promise<void> {
  await initRepositories();
  await bootstrapAdmins();
}
