-- Reply Assistant PostgreSQL Schema
-- issue_threads 額外欄位（risk_level, knowledge_card_id, is_waiting, is_stale,
-- last_message_at, resolved_at, metadata_json）屬於 issueThread 內部狀態追蹤，
-- 不是 event_log 固定欄位。event_log 欄位才是固定不得擴充。

CREATE TABLE IF NOT EXISTS group_flags (
  group_id TEXT PRIMARY KEY,
  waiting_flag BOOLEAN NOT NULL DEFAULT FALSE,
  waiting_flag_set_at TIMESTAMPTZ,
  mute BOOLEAN NOT NULL DEFAULT FALSE,
  mute_until TEXT,
  service_start_at TIMESTAMPTZ,
  service_end_at TIMESTAMPTZ,
  active_issue_thread_id TEXT,
  service_reactivation_pending BOOLEAN NOT NULL DEFAULT FALSE,
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
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_by TEXT,
  approved_at TIMESTAMPTZ,
  disabled_at TIMESTAMPTZ,
  CONSTRAINT consultants_role_check CHECK (role IN ('admin', 'consultant')),
  CONSTRAINT consultants_status_check CHECK (status IN ('pending', 'active', 'disabled'))
);

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
