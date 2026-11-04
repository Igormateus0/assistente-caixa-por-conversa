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

  -- Supabase API roles receive no row policies; the backend role is explicitly scoped below.
  -- The application server connects directly to Postgres and must keep its credentials private.
  ALTER TABLE users ENABLE ROW LEVEL SECURITY;
  ALTER TABLE pending_entries ENABLE ROW LEVEL SECURITY;
  ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
  ALTER TABLE pending_operations ENABLE ROW LEVEL SECURITY;
  ALTER TABLE transaction_events ENABLE ROW LEVEL SECURITY;

-- Papel de aplicação sem privilégios administrativos. O provisionamento atribui
-- LOGIN e senha fora do Git; este papel nunca é dono das tabelas nem BYPASSRLS.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'assistente_caixa_app') THEN
    CREATE ROLE assistente_caixa_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO assistente_caixa_app;
REVOKE ALL ON TABLE users, pending_entries, transactions, pending_operations, transaction_events FROM assistente_caixa_app;
REVOKE ALL ON SEQUENCE public.users_id_seq, public.pending_entries_id_seq, public.transactions_id_seq, public.pending_operations_id_seq, public.transaction_events_id_seq FROM assistente_caixa_app;
GRANT USAGE, SELECT ON SEQUENCE public.users_id_seq, public.pending_entries_id_seq, public.transactions_id_seq, public.pending_operations_id_seq, public.transaction_events_id_seq TO assistente_caixa_app;

GRANT SELECT (id, whatsapp_id, timezone), INSERT (whatsapp_id), UPDATE (whatsapp_id)
  ON TABLE users TO assistente_caixa_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE pending_entries, pending_operations TO assistente_caixa_app;
GRANT SELECT ON TABLE transactions TO assistente_caixa_app;
GRANT INSERT (user_id, entry_type, amount_cents, category, description, service_minutes, source_message_id)
  ON TABLE transactions TO assistente_caixa_app;
GRANT UPDATE (entry_type, amount_cents, category, description, occurred_at, updated_at, reversed_at)
  ON TABLE transactions TO assistente_caixa_app;
GRANT SELECT, INSERT ON TABLE transaction_events TO assistente_caixa_app;

-- O backend define app.user_key dentro da transação depois de validar o usuário
-- no canal (Telegram/WhatsApp/simulador). Sem esse contexto, as políticas negam linhas.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
ALTER TABLE pending_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE pending_entries FORCE ROW LEVEL SECURITY;
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions FORCE ROW LEVEL SECURITY;
ALTER TABLE pending_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE pending_operations FORCE ROW LEVEL SECURITY;
ALTER TABLE transaction_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE transaction_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS app_user_key_isolation ON users;
CREATE POLICY app_user_key_isolation ON users TO assistente_caixa_app
  USING (whatsapp_id = current_setting('app.user_key', true))
  WITH CHECK (whatsapp_id = current_setting('app.user_key', true));

DROP POLICY IF EXISTS app_user_key_isolation ON pending_entries;
CREATE POLICY app_user_key_isolation ON pending_entries TO assistente_caixa_app
  USING (user_id = (SELECT id FROM users WHERE whatsapp_id = current_setting('app.user_key', true)))
  WITH CHECK (user_id = (SELECT id FROM users WHERE whatsapp_id = current_setting('app.user_key', true)));

DROP POLICY IF EXISTS app_user_key_isolation ON transactions;
CREATE POLICY app_user_key_isolation ON transactions TO assistente_caixa_app
  USING (user_id = (SELECT id FROM users WHERE whatsapp_id = current_setting('app.user_key', true)))
  WITH CHECK (user_id = (SELECT id FROM users WHERE whatsapp_id = current_setting('app.user_key', true)));

DROP POLICY IF EXISTS app_user_key_isolation ON pending_operations;
CREATE POLICY app_user_key_isolation ON pending_operations TO assistente_caixa_app
  USING (user_id = (SELECT id FROM users WHERE whatsapp_id = current_setting('app.user_key', true)))
  WITH CHECK (user_id = (SELECT id FROM users WHERE whatsapp_id = current_setting('app.user_key', true)));

DROP POLICY IF EXISTS app_user_key_isolation ON transaction_events;
CREATE POLICY app_user_key_isolation ON transaction_events TO assistente_caixa_app
  USING (user_id = (SELECT id FROM users WHERE whatsapp_id = current_setting('app.user_key', true)))
  WITH CHECK (user_id = (SELECT id FROM users WHERE whatsapp_id = current_setting('app.user_key', true)));
