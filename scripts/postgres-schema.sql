CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  username TEXT,
  first_name TEXT,
  birth_date TEXT,
  avatar_url TEXT,
  city TEXT,
  gender TEXT,
  has_children TEXT,
  smokes TEXT,
  drinks_alcohol TEXT,
  has_car TEXT,
  blocked_at TEXT,
  email_verified_at TEXT,
  email_verification_token TEXT,
  email_verification_expires_at TEXT,
  pending_open_character_id TEXT,
  pending_email_change TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_ci ON users (lower(email));
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_verification_token
  ON users(email_verification_token)
  WHERE email_verification_token IS NOT NULL;

CREATE TABLE IF NOT EXISTS operators (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'staff' CHECK(role IN ('owner','staff')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  disabled_at TEXT,
  payout_first_name TEXT,
  payout_last_name TEXT,
  payout_address_line TEXT,
  payout_city TEXT,
  payout_postal_code TEXT,
  payout_country TEXT,
  payout_iban TEXT,
  payout_frequency TEXT,
  kyc_status TEXT,
  kyc_provider_ref TEXT,
  kyc_updated_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_operators_email_ci ON operators (lower(email));

CREATE TABLE IF NOT EXISTS customer_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS operator_sessions (
  id TEXT PRIMARY KEY,
  operator_id TEXT NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_customer_sessions_token ON customer_sessions(token);
CREATE INDEX IF NOT EXISTS idx_operator_sessions_token ON operator_sessions(token);

CREATE TABLE IF NOT EXISTS characters (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  tagline TEXT NOT NULL,
  category TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  portrait_url TEXT,
  gender TEXT,
  skills TEXT,
  about TEXT,
  typical_hours_from TEXT,
  typical_hours_to TEXT
);

CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  internal_notes TEXT,
  assigned_operator_id TEXT REFERENCES operators(id) ON DELETE SET NULL,
  response_due_at TEXT,
  last_staff_activity_at TEXT,
  reclaim_operator_id TEXT,
  reclaim_until TEXT,
  resume_operator_id TEXT,
  resume_until TEXT,
  client_hidden_at TEXT,
  UNIQUE(user_id, character_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  sender TEXT NOT NULL CHECK(sender IN ('user','staff')),
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  operator_id TEXT REFERENCES operators(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS thread_facts (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK(scope IN ('client','consultant')),
  category TEXT NOT NULL,
  field TEXT NOT NULL,
  slot INTEGER NOT NULL DEFAULT 0,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_operator_id TEXT,
  updated_operator_id TEXT,
  UNIQUE(thread_id, scope, category, field, slot)
);

CREATE TABLE IF NOT EXISTS ledger (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delta INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS app_kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS promo_campaigns (
  id TEXT PRIMARY KEY,
  campaign_key TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  discount_percent INTEGER NOT NULL DEFAULT 0,
  start_at TEXT,
  end_at TEXT,
  is_active INTEGER NOT NULL DEFAULT 0,
  capture_email INTEGER NOT NULL DEFAULT 0,
  code_prefix TEXT NOT NULL DEFAULT 'SZEPT',
  max_codes INTEGER NOT NULL DEFAULT 0,
  total_claimed INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS promo_codes (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES promo_campaigns(id) ON DELETE CASCADE,
  email TEXT,
  code TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'claimed',
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TEXT,
  used_at TEXT,
  meta_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_promo_codes_campaign ON promo_codes(campaign_id);
CREATE INDEX IF NOT EXISTS idx_promo_codes_email ON promo_codes(email);

CREATE TABLE IF NOT EXISTS payment_transactions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  gateway TEXT NOT NULL,
  external_id TEXT,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'PLN',
  status TEXT NOT NULL DEFAULT 'created',
  package_amount INTEGER,
  redirect_url TEXT,
  payload_json TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  paid_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_payment_tx_user ON payment_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_payment_tx_status ON payment_transactions(status);

CREATE TABLE IF NOT EXISTS operator_payout_ledger (
  id TEXT PRIMARY KEY,
  operator_id TEXT NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  amount_pln REAL NOT NULL,
  label TEXT NOT NULL,
  period_label TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_payout_ledger_op ON operator_payout_ledger(operator_id);

CREATE TABLE IF NOT EXISTS operator_audit (
  id TEXT PRIMARY KEY,
  operator_id TEXT NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  thread_id TEXT,
  detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS message_reports (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  reporter_operator_id TEXT NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'resolved')),
  owner_note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TEXT,
  resolved_by_operator_id TEXT REFERENCES operators(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_message_reports_status ON message_reports(status);
CREATE INDEX IF NOT EXISTS idx_message_reports_thread ON message_reports(thread_id);
CREATE INDEX IF NOT EXISTS idx_message_reports_message ON message_reports(message_id);
