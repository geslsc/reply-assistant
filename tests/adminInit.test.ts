import { loadEnv, resetEnvCache } from '../src/config/env';
import { bootstrapAdmins } from '../src/bootstrap';
import { initRepositories, getRepos } from '../src/repositories';
import { processMessage } from '../src/handlers/lineWebhookHandler';

describe('Admin Initialization Tests', () => {
  beforeEach(async () => {
    resetEnvCache();
    loadEnv({
      NODE_ENV: 'test',
      USE_MEMORY_REPOS: true,
      ADMIN_LINE_USER_IDS: [],
    });
    await initRepositories('memory');
  });

  it('upserts active admin when ADMIN_LINE_USER_IDS is set', async () => {
    resetEnvCache();
    loadEnv({
      NODE_ENV: 'test',
      USE_MEMORY_REPOS: true,
      ADMIN_LINE_USER_IDS: ['U-admin-001', 'U-admin-002'],
    });
    await initRepositories('memory');
    await bootstrapAdmins();

    const admin1 = await getRepos().consultants.findById('U-admin-001');
    const admin2 = await getRepos().consultants.findById('U-admin-002');
    expect(admin1?.status).toBe('active');
    expect(admin1?.role).toBe('admin');
    expect(admin2?.status).toBe('active');
  });

  it('starts without ADMIN_LINE_USER_IDS', async () => {
    await bootstrapAdmins();
    const admins = await getRepos().consultants.findActiveAdmins();
    expect(admins.length).toBe(0);
  });

  it('logs userId in private message response for setup', async () => {
    const result = await processMessage({
      userId: 'U-copy-me',
      text: 'hello',
      isGroup: false,
    });
    expect(result.replies[0].text).toContain('U-copy-me');
  });
});
