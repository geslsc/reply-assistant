import { Pool } from 'pg';
import request from 'supertest';
import express, { Request, Response } from 'express';
import { Actor, EventType, ThreadState, TIMEOUT_MS } from '../src/types';
import { loadEnv, resetEnvCache } from '../src/config/env';
import { dropAllTables, resetDatabase, setPoolForTests, closePool } from '../src/db/client';
import { createPostgresRepositories } from '../src/repositories/postgresRepositories';
import { initRepositories } from '../src/repositories';
import { loadKnowledgeBase, matchKnowledgeCard, pauseCard } from '../src/services/knowledgeBaseService';
import { settleGroupTimeouts } from '../src/services/passiveTimeoutSettlement';
import {
  createIssueThread,
  getIssueThread,
  updateIssueThread,
} from '../src/services/issueThreadService';
import { checkDbConnection } from '../src/db/client';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describePg = TEST_DATABASE_URL ? describe : describe.skip;

describePg('PostgreSQL Integration Tests', () => {
  let pool: Pool;

  beforeAll(async () => {
    resetEnvCache();
    loadEnv({
      NODE_ENV: 'test',
      USE_MEMORY_REPOS: false,
      DATABASE_URL: TEST_DATABASE_URL!,
    });
    pool = new Pool({ connectionString: TEST_DATABASE_URL });
    setPoolForTests(pool);
    await resetDatabase(pool);
    await initRepositories('postgres');
    loadKnowledgeBase();
  });

  afterAll(async () => {
    await dropAllTables(pool);
    await pool.end();
    setPoolForTests(null);
    await closePool();
  });

  beforeEach(async () => {
    await dropAllTables(pool);
    await resetDatabase(pool);
    const repos = createPostgresRepositories(pool);
    await repos.groups.clear();
    await repos.threads.clear();
    await repos.events.clear();
    await repos.consultants.clear();
    await repos.knowledgeOverrides.clear();
  });

  it('migration creates schema successfully', async () => {
    const result = await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'event_logs'`
    );
    expect(result.rowCount).toBe(1);
  });

  it('group_flags CRUD works', async () => {
    const repos = createPostgresRepositories(pool);
    const flags = await repos.groups.getOrCreate('group-pg-1');
    expect(flags.groupId).toBe('group-pg-1');

    const updated = await repos.groups.update('group-pg-1', { waitingFlag: true });
    expect(updated.waitingFlag).toBe(true);
  });

  it('issue_threads CRUD uses group_id + issue_thread_id', async () => {
    const repos = createPostgresRepositories(pool);
    const thread = await repos.threads.create('group-pg-1', 'question');
    const loaded = await repos.threads.findById('group-pg-1', thread.issueThreadId);
    expect(loaded?.groupId).toBe('group-pg-1');

    const wrongGroup = await repos.threads.findById('group-pg-2', thread.issueThreadId);
    expect(wrongGroup).toBeNull();
  });

  it('event_logs write succeeds', async () => {
    const repos = createPostgresRepositories(pool);
    const entry = await repos.events.create({
      event_type: EventType.KNOWLEDGE_HIT,
      group_id: 'group-pg-1',
      actor: Actor.BOT,
    });
    expect(entry.event_type).toBe(EventType.KNOWLEDGE_HIT);
  });

  it('rejects invalid event_type at DB layer', async () => {
    await expect(
      pool.query(
        `INSERT INTO event_logs (event_id, timestamp, event_type, actor)
         VALUES ($1, NOW(), $2, $3)`,
        ['evt-1', 'invalid_type', 'bot']
      )
    ).rejects.toThrow();
  });

  it('rejects invalid actor at DB layer', async () => {
    await expect(
      pool.query(
        `INSERT INTO event_logs (event_id, timestamp, event_type, actor)
         VALUES ($1, NOW(), $2, $3)`,
        ['evt-2', EventType.KNOWLEDGE_HIT, 'invalid_actor']
      )
    ).rejects.toThrow();
  });

  it('rejects invalid risk_level at DB layer', async () => {
    await expect(
      pool.query(
        `INSERT INTO event_logs (event_id, timestamp, event_type, actor, risk_level)
         VALUES ($1, NOW(), $2, $3, $4)`,
        ['evt-3', EventType.KNOWLEDGE_HIT, Actor.BOT, 'critical']
      )
    ).rejects.toThrow();
  });

  it('rejects invalid consultant role/status at DB layer', async () => {
    await expect(
      pool.query(
        `INSERT INTO consultants (line_user_id, role, status) VALUES ($1, $2, $3)`,
        ['U1', 'superadmin', 'active']
      )
    ).rejects.toThrow();

    await expect(
      pool.query(
        `INSERT INTO consultants (line_user_id, role, status) VALUES ($1, $2, $3)`,
        ['U2', 'consultant', 'deleted']
      )
    ).rejects.toThrow();
  });

  it('rejects invalid knowledge override status at DB layer', async () => {
    await expect(
      pool.query(
        `INSERT INTO knowledge_overrides (knowledge_card_id, status_override)
         VALUES ($1, $2)`,
        ['op-login', 'deleted']
      )
    ).rejects.toThrow();
  });

  it('rejects invalid issue_threads.state at DB layer', async () => {
    await expect(
      pool.query(
        `INSERT INTO issue_threads (
          group_id, issue_thread_id, status, state, last_message_at
        ) VALUES ($1, $2, $3, $4, NOW())`,
        ['group-pg-1', 'thread-1', 'active', 'AI_WAITING']
      )
    ).rejects.toThrow();
  });

  it('rejects invalid issue_threads.status at DB layer', async () => {
    await expect(
      pool.query(
        `INSERT INTO issue_threads (
          group_id, issue_thread_id, status, state, last_message_at
        ) VALUES ($1, $2, $3, $4, NOW())`,
        ['group-pg-1', 'thread-2', 'deleted', ThreadState.IDLE]
      )
    ).rejects.toThrow();
  });

  it('rejects invalid issue_threads.risk_level at DB layer', async () => {
    await expect(
      pool.query(
        `INSERT INTO issue_threads (
          group_id, issue_thread_id, status, state, risk_level, last_message_at
        ) VALUES ($1, $2, $3, $4, $5, NOW())`,
        ['group-pg-1', 'thread-3', 'active', ThreadState.IDLE, 'critical']
      )
    ).rejects.toThrow();
  });

  it('knowledge override pause prevents public card match', async () => {
    await initRepositories('postgres');
    await pauseCard('op-login', 'admin-001', 'test');
    const match = await matchKnowledgeCard('怎麼登入後台');
    expect(match.card?.id).not.toBe('op-login');
  });

  it('batch stale settles multiple threads in same group', async () => {
    await initRepositories('postgres');
    const t1 = await createIssueThread('group-pg-a', 'q1');
    const t2 = await createIssueThread('group-pg-a', 'q2');

    await updateIssueThread('group-pg-a', t1.issueThreadId, {
      state: ThreadState.AI_CLARIFYING,
      lastStateChangeAt: new Date(Date.now() - TIMEOUT_MS.AI_CLARIFYING - 1000).toISOString(),
    });
    await updateIssueThread('group-pg-a', t2.issueThreadId, {
      state: ThreadState.CONSULTANT_HANDOFF,
      lastStateChangeAt: new Date(Date.now() - TIMEOUT_MS.CONSULTANT_HANDOFF - 1000).toISOString(),
    });

    const result = await settleGroupTimeouts('group-pg-a', new Date());
    expect(result.settledThreads.length).toBe(2);
  });

  it('does not stale threads from other groups', async () => {
    await initRepositories('postgres');
    const other = await createIssueThread('group-pg-b', 'other');
    await updateIssueThread('group-pg-b', other.issueThreadId, {
      state: ThreadState.AI_CLARIFYING,
      lastStateChangeAt: new Date(Date.now() - TIMEOUT_MS.AI_CLARIFYING - 1000).toISOString(),
    });

    await settleGroupTimeouts('group-pg-a', new Date());
    expect((await getIssueThread('group-pg-b', other.issueThreadId))!.state).toBe(
      ThreadState.AI_CLARIFYING
    );
  });

  it('health returns connected when DB is available', async () => {
    const connected = await checkDbConnection();
    expect(connected).toBe(true);

    const app = express();
    app.get('/health', async (_req: Request, res: Response) => {
      const ok = await checkDbConnection();
      res.json({ ok, service: 'reply-assistant', db: ok ? 'connected' : 'disconnected' });
    });

    const response = await request(app).get('/health');
    expect(response.status).toBe(200);
    expect(response.body.db).toBe('connected');
  });

  it('health returns disconnected when DB pool fails', async () => {
    const badPool = new Pool({ connectionString: 'postgresql://invalid:invalid@127.0.0.1:1/nope' });
    setPoolForTests(badPool);

    const app = express();
    app.get('/health', async (_req: Request, res: Response) => {
      const ok = await checkDbConnection();
      if (!ok) {
        res.status(503).json({ ok: false, service: 'reply-assistant', db: 'disconnected' });
        return;
      }
      res.json({ ok: true, service: 'reply-assistant', db: 'connected' });
    });

    const response = await request(app).get('/health');
    expect(response.status).toBe(503);
    expect(response.body.db).toBe('disconnected');

    setPoolForTests(pool);
  });
});
