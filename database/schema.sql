  CREATE TABLE IF NOT EXISTS users (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    whatsapp_id TEXT NOT NULL UNIQUE,
    display_name TEXT,
    timezone TEXT NOT NULL DEFAULT 'America/Bahia',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS pending_entries (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    entry_type TEXT NOT NULL CHECK (entry_type IN ('income', 'expense')),
    amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
    category TEXT NOT NULL,
    description TEXT,
    service_minutes INTEGER CHECK (service_minutes IS NULL OR service_minutes > 0),
    source_message_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id)
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    entry_type TEXT NOT NULL CHECK (entry_type IN ('income', 'expense')),
    amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
    category TEXT NOT NULL,
    description TEXT,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    service_minutes INTEGER CHECK (service_minutes IS NULL OR service_minutes > 0),
    source_message_id TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    reversed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, source_message_id)
  );

  -- Migração aditiva para bancos que já possuem a tabela transactions.
  ALTER TABLE transactions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
  ALTER TABLE transactions ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ;

  CREATE TABLE IF NOT EXISTS pending_operations (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE UNIQUE,
    transaction_id BIGINT NOT NULL REFERENCES transactions(id),
    operation_type TEXT NOT NULL CHECK (operation_type IN ('edit', 'reverse')),
    changes JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS transaction_events (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    transaction_id BIGINT NOT NULL REFERENCES transactions(id),
    event_type TEXT NOT NULL CHECK (event_type IN ('created', 'updated', 'reversed')),
    before_data JSONB,
    after_data JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE INDEX IF NOT EXISTS transactions_user_date_idx
    ON transactions (user_id, occurred_at DESC);

  -- Deny access through Supabase's public API until explicit per-user policies exist.
  -- The application server connects directly to Postgres and must keep its credentials private.
  ALTER TABLE users ENABLE ROW LEVEL SECURITY;
  ALTER TABLE pending_entries ENABLE ROW LEVEL SECURITY;
  ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
  ALTER TABLE pending_operations ENABLE ROW LEVEL SECURITY;
  ALTER TABLE transaction_events ENABLE ROW LEVEL SECURITY;
