-- Reply Assistant PostgreSQL Schema
-- issue_threads 額外欄位（risk_level, knowledge_card_id, is_waiting, is_stale,
-- last_message_at, resolved_at, metadata_json）屬於 issueThread 內部狀態追蹤，
-- 不是 event_log 固定欄位。event_log 欄位才是固定不得擴充。

CREATE TABLE IF NOT EXISTS group_flags (
  group_id TEXT PRIMARY KEY,
  group_name TEXT,
  waiting_flag BOOLEAN NOT NULL DEFAULT FALSE,
  waiting_flag_set_at TIMESTAMPTZ,
  mute BOOLEAN NOT NULL DEFAULT FALSE,
  mute_until TEXT,
  service_start_at TIMESTAMPTZ,
  service_end_at TIMESTAMPTZ,
  active_issue_thread_id TEXT,
  service_reactivation_pending BOOLEAN NOT NULL DEFAULT FALSE,
  bot_left_at TIMESTAMPTZ,
  service_period_end_notified BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS issue_threads (
  group_id TEXT NOT NULL,
  issue_thread_id TEXT NOT NULL,
  status TEXT NOT NULL,
  state TEXT NOT NULL,
  -- 內部追蹤：最近一次命中知識卡風險等級（非 event_log 欄位）
  risk_level TEXT,
  -- 內部追蹤：最近一次引用 knowledge_card_id
  knowledge_card_id TEXT,
  has_substantive_answer BOOLEAN NOT NULL DEFAULT FALSE,
  clarify_count INTEGER NOT NULL DEFAULT 0,
  -- 內部 thread 追蹤旗標：顧問 handoff 期間的內部流程標記（非狀態機 state enum）
  is_waiting BOOLEAN NOT NULL DEFAULT FALSE,
  -- 內部追蹤：被動 stale 批次標記
  is_stale BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- 內部追蹤：最後狀態變更 / 訊息時間，供被動逾時結算
  last_message_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  -- 內部追蹤：consultantAnswered, customerQuestion 等 JSON
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (group_id, issue_thread_id),
  CONSTRAINT issue_threads_status_check CHECK (
    status IN ('active', 'resolved', 'waiting')
  ),
  CONSTRAINT issue_threads_state_check CHECK (
    state IN (
      'IDLE',
      'AI_CLARIFYING',
      'AI_ANSWERING',
      'CONSULTANT_HANDOFF',
      'OUT_OF_SERVICE_PERIOD'
    )
  ),
  CONSTRAINT issue_threads_risk_level_check CHECK (
    risk_level IS NULL OR risk_level IN ('low', 'mid', 'high', 'unknown')
  )
);

CREATE INDEX IF NOT EXISTS idx_issue_threads_group_id ON issue_threads(group_id);
CREATE INDEX IF NOT EXISTS idx_issue_threads_state ON issue_threads(state);
CREATE INDEX IF NOT EXISTS idx_issue_threads_last_message_at ON issue_threads(last_message_at);

CREATE TABLE IF NOT EXISTS event_logs (
  event_id TEXT PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL,
  event_type TEXT NOT NULL,
  group_id TEXT,
  issue_thread_id TEXT,
  actor TEXT NOT NULL,
  actor_user_id TEXT,
  risk_level TEXT,
  from_state TEXT,
  to_state TEXT,
  knowledge_card_id TEXT,
  detail TEXT,
  service_day INTEGER,
  CONSTRAINT event_logs_event_type_check CHECK (
    event_type IN (
      'state_transition',
      'ai_answer',
      'knowledge_hit',
      'knowledge_miss',
      'handoff_to_consultant',
      'consultant_override',
      'consultant_correction',
      'official_cs_redirect',
      'unknown_question',
      'consultant_mute'
    )
  ),
  CONSTRAINT event_logs_actor_check CHECK (
    actor IN ('bot', 'consultant', 'customer', 'system')
  ),
  CONSTRAINT event_logs_risk_level_check CHECK (
    risk_level IS NULL OR risk_level IN ('low', 'mid', 'high', 'unknown')
  )
);

CREATE INDEX IF NOT EXISTS idx_event_logs_group_id ON event_logs(group_id);
CREATE INDEX IF NOT EXISTS idx_event_logs_event_type ON event_logs(event_type);
CREATE INDEX IF NOT EXISTS idx_event_logs_timestamp ON event_logs(timestamp);

CREATE TABLE IF NOT EXISTS consultants (
  line_user_id TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  status TEXT NOT NULL,
  invite_code TEXT,
  display_name TEXT,
  consultant_code TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_by TEXT,
  approved_at TIMESTAMPTZ,
  disabled_by TEXT,
  disabled_at TIMESTAMPTZ,
  last_knowledge_export_at TIMESTAMPTZ,
  CONSTRAINT consultants_role_check CHECK (role IN ('admin', 'consultant')),
  CONSTRAINT consultants_status_check CHECK (status IN ('active', 'disabled'))
);

ALTER TABLE consultants ADD COLUMN IF NOT EXISTS consultant_code TEXT;
ALTER TABLE consultants ADD COLUMN IF NOT EXISTS disabled_by TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_consultants_consultant_code
  ON consultants(consultant_code) WHERE consultant_code IS NOT NULL;
ALTER TABLE consultants DROP CONSTRAINT IF EXISTS consultants_status_check;
ALTER TABLE consultants ADD CONSTRAINT consultants_status_check CHECK (status IN ('active', 'disabled'));
ALTER TABLE group_flags ADD COLUMN IF NOT EXISTS bot_left_at TIMESTAMPTZ;
ALTER TABLE group_flags ADD COLUMN IF NOT EXISTS service_period_end_notified BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS consultant_applications (
  application_id TEXT PRIMARY KEY,
  application_code TEXT UNIQUE NOT NULL,
  user_id TEXT NOT NULL,
  display_name TEXT,
  status TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL,
  resolved_at TIMESTAMPTZ,
  resolved_by TEXT,
  admin_response TEXT,
  CONSTRAINT consultant_applications_status_check CHECK (
    status IN ('pending', 'approved', 'rejected')
  )
);

CREATE INDEX IF NOT EXISTS idx_consultant_applications_status ON consultant_applications(status);
CREATE INDEX IF NOT EXISTS idx_consultant_applications_user_id ON consultant_applications(user_id);

-- pending_handoffs：僅用於私訊代回群組流程，不得作知識卡草稿儲存區
CREATE TABLE IF NOT EXISTS pending_handoffs (
  id TEXT PRIMARY KEY,
  consultant_id TEXT NOT NULL,
  issue_thread_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  short_code TEXT NOT NULL,
  status TEXT NOT NULL,
  invalid_reason TEXT,
  customer_question TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMPTZ,
  snoozed BOOLEAN NOT NULL DEFAULT FALSE,
  acknowledged_at TIMESTAMPTZ,
  CONSTRAINT pending_handoffs_status_check CHECK (
    status IN ('open', 'closed', 'invalid')
  ),
  CONSTRAINT pending_handoffs_invalid_reason_check CHECK (
    invalid_reason IS NULL OR invalid_reason IN (
      'passive_timeout',
      'group_muted',
      'service_ended',
      'out_of_service'
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_pending_handoffs_consultant ON pending_handoffs(consultant_id);
CREATE INDEX IF NOT EXISTS idx_pending_handoffs_short_code ON pending_handoffs(short_code);
CREATE INDEX IF NOT EXISTS idx_pending_handoffs_group ON pending_handoffs(group_id);

ALTER TABLE consultants ADD COLUMN IF NOT EXISTS last_knowledge_export_at TIMESTAMPTZ;
ALTER TABLE group_flags ADD COLUMN IF NOT EXISTS group_name TEXT;
ALTER TABLE pending_handoffs ADD COLUMN IF NOT EXISTS snoozed BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE pending_handoffs ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS knowledge_cards (
  card_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  patterns TEXT[] NOT NULL,
  risk_level TEXT NOT NULL,
  can_public_reply BOOLEAN NOT NULL,
  standard_answer TEXT NOT NULL,
  not_applicable TEXT[],
  escalate_to_consultant TEXT[],
  status TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_by TEXT,
  updated_at TIMESTAMPTZ,
  confirmed_by TEXT NOT NULL,
  confirmed_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT knowledge_cards_risk_level_check CHECK (
    risk_level IN ('low', 'mid', 'high', 'unknown')
  ),
  CONSTRAINT knowledge_cards_status_check CHECK (
    status IN ('active', 'paused')
  )
);

CREATE INDEX IF NOT EXISTS idx_knowledge_cards_status ON knowledge_cards(status);
CREATE INDEX IF NOT EXISTS idx_knowledge_cards_risk_level ON knowledge_cards(risk_level);

CREATE TABLE IF NOT EXISTS invite_codes (
  code TEXT PRIMARY KEY,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS knowledge_overrides (
  knowledge_card_id TEXT PRIMARY KEY,
  status_override TEXT NOT NULL,
  reason TEXT,
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT knowledge_overrides_status_check CHECK (status_override IN ('暫停'))
);

-- pending_knowledge_reviews：僅用於顧問送審 → admin 審核，不得作其他用途
CREATE TABLE IF NOT EXISTS pending_knowledge_reviews (
  review_id TEXT PRIMARY KEY,
  card_data JSONB NOT NULL,
  submitted_by TEXT NOT NULL,
  submitted_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL,
  bot_message_id TEXT,
  admin_response TEXT,
  resolved_at TIMESTAMPTZ,
  resolved_by TEXT,
  CONSTRAINT pending_knowledge_reviews_status_check CHECK (
    status IN ('pending', 'approved', 'rejected', 'expired')
  )
);

CREATE INDEX IF NOT EXISTS idx_pending_knowledge_reviews_status ON pending_knowledge_reviews(status);
CREATE INDEX IF NOT EXISTS idx_pending_knowledge_reviews_bot_message_id ON pending_knowledge_reviews(bot_message_id);

-- dm_sessions：僅用於私訊草稿暫存，不是正式知識庫、不是待審區
CREATE TABLE IF NOT EXISTS dm_sessions (
  session_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  session_type TEXT NOT NULL,
  status TEXT NOT NULL,
  draft_data JSONB,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  expired_at TIMESTAMPTZ,
  CONSTRAINT dm_sessions_session_type_check CHECK (session_type IN ('knowledge_draft')),
  CONSTRAINT dm_sessions_status_check CHECK (
    status IN ('active', 'submitted', 'completed', 'cancelled', 'expired')
  )
);

CREATE INDEX IF NOT EXISTS idx_dm_sessions_user_id ON dm_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_dm_sessions_status ON dm_sessions(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dm_sessions_one_active_per_user
  ON dm_sessions(user_id) WHERE status = 'active';

-- group_message_buffers：群組店家訊息收斂 buffer（debounce 期間持久化）
CREATE TABLE IF NOT EXISTS group_message_buffers (
  buffer_id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  customer_user_id TEXT NOT NULL,
  issue_thread_id TEXT NOT NULL,
  messages_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'collecting',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT group_message_buffers_status_check CHECK (
    status IN ('collecting', 'resolved', 'expired')
  )
);

CREATE INDEX IF NOT EXISTS idx_group_message_buffers_group_customer_collecting
  ON group_message_buffers(group_id, customer_user_id)
  WHERE status = 'collecting';

CREATE INDEX IF NOT EXISTS idx_group_message_buffers_collecting_updated
  ON group_message_buffers(status, updated_at)
  WHERE status = 'collecting';

-- group_consultant_assignments：群組與負責顧問綁定（主負責 / 副手）
CREATE TABLE IF NOT EXISTS group_consultant_assignments (
  id SERIAL PRIMARY KEY,
  group_id TEXT NOT NULL UNIQUE,
  group_code TEXT UNIQUE NOT NULL,
  group_name TEXT,
  primary_consultant_user_id TEXT,
  secondary_consultant_user_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by TEXT,
  last_consultant_action_at TIMESTAMPTZ,
  last_customer_message_at TIMESTAMPTZ,
  CONSTRAINT group_consultant_assignments_status_check CHECK (
    status IN ('active', 'left')
  )
);

CREATE INDEX IF NOT EXISTS idx_group_consultant_assignments_primary
  ON group_consultant_assignments(primary_consultant_user_id);
CREATE INDEX IF NOT EXISTS idx_group_consultant_assignments_secondary
  ON group_consultant_assignments(secondary_consultant_user_id);
CREATE INDEX IF NOT EXISTS idx_group_consultant_assignments_group_code
  ON group_consultant_assignments(group_code);
