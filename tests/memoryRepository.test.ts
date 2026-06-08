import { EventType, ThreadState } from '../src/types';
import { getRepos } from '../src/repositories';
import { Actor } from '../src/types';
import { pauseCard } from '../src/services/knowledgeBaseService';
import {
  registerAdmin,
  requestConsultantJoin,
  approveConsultant,
  registerInviteCode,
  disableConsultant,
} from '../src/services/consultantWhitelist';
import { TEST_ADMIN, TEST_CONSULTANT, TEST_GROUP } from './helpers/testSetup';

describe('Memory Repository Tests', () => {
  it('group flags can be written, updated, and read', async () => {
    const repos = getRepos();
    const flags = await repos.groups.getOrCreate(TEST_GROUP);
    expect(flags.waitingFlag).toBe(false);

    const updated = await repos.groups.update(TEST_GROUP, {
      waitingFlag: true,
      waitingFlagSetAt: new Date().toISOString(),
    });
    expect(updated.waitingFlag).toBe(true);

    const read = await repos.groups.getOrCreate(TEST_GROUP);
    expect(read.waitingFlag).toBe(true);
  });

  it('issue thread can be written, updated, and queried by group', async () => {
    const repos = getRepos();
    const thread = await repos.threads.create(TEST_GROUP, 'question');
    expect(thread.groupId).toBe(TEST_GROUP);

    const updated = await repos.threads.update(TEST_GROUP, thread.issueThreadId, {
      state: ThreadState.AI_CLARIFYING,
      clarifyRound: 1,
    });
    expect(updated?.state).toBe(ThreadState.AI_CLARIFYING);

    const byGroup = await repos.threads.findByGroup(TEST_GROUP);
    expect(byGroup.length).toBe(1);
  });

  it('event_log writes and restricts enum values', async () => {
    const repos = getRepos();
    const entry = await repos.events.create({
      event_type: EventType.KNOWLEDGE_HIT,
      group_id: TEST_GROUP,
      actor: Actor.BOT,
    });
    expect(entry.event_type).toBe(EventType.KNOWLEDGE_HIT);

    await expect(
      repos.events.create({ event_type: 'invalid_type' as EventType })
    ).rejects.toThrow(/Invalid event_type/);
  });

  it('consultant pending / active / disabled flow works', async () => {
    await registerAdmin(TEST_ADMIN);
    await registerInviteCode('TESTCODE', TEST_ADMIN);
    await requestConsultantJoin(TEST_CONSULTANT, 'TESTCODE');
    await approveConsultant(TEST_ADMIN, TEST_CONSULTANT);

    const active = await getRepos().consultants.findById(TEST_CONSULTANT);
    expect(active?.status).toBe('active');

    await disableConsultant(TEST_ADMIN, TEST_CONSULTANT);
    const disabled = await getRepos().consultants.findById(TEST_CONSULTANT);
    expect(disabled?.status).toBe('disabled');
  });

  it('knowledge override pauses JSON card', async () => {
    await pauseCard('op-login', TEST_ADMIN, '需要修正');
    const override = await getRepos().knowledgeOverrides.findByCardId('op-login');
    expect(override?.statusOverride).toBe('暫停');
  });
});
