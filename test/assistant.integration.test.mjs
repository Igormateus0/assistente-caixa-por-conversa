import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { Pool } from 'pg';
import { handleAssistantMessage } from '../dist/assistant.js';

assert.ok(process.env.DATABASE_TEST_URL, 'DATABASE_TEST_URL ausente; configure um banco separado em .env.test');
assert.ok(process.env.DATABASE_TEST_ADMIN_URL, 'DATABASE_TEST_ADMIN_URL ausente; configure a conexão administrativa do banco de teste');

const pool = new Pool({ connectionString: process.env.DATABASE_TEST_URL, max: 1 });
const adminPool = new Pool({ connectionString: process.env.DATABASE_TEST_ADMIN_URL, max: 1 });

before(async () => {
  const schema = await adminPool.query(`
    SELECT to_regclass('public.pending_operations') IS NOT NULL AS pending_operations,
           to_regclass('public.transaction_events') IS NOT NULL AS transaction_events,
           EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'transactions'
               AND column_name = 'reversed_at') AS reversed_at
  `);
  assert.deepEqual(schema.rows[0], {
    pending_operations: true, transaction_events: true, reversed_at: true,
  }, 'Aplique database/schema.sql somente no banco de teste antes da integração');
});

after(async () => {
  await pool.end();
  await adminPool.end();
});

async function fixture(context) {
  const userKey = 'integration-test:' + randomUUID();
  const otherUserKey = 'integration-test-other:' + randomUUID();
  let messageNumber = 0;
  const sendAs = (userId, text) => handleAssistantMessage(pool, {
    userId,
    messageId: userId + ':' + (++messageNumber),
    text,
  });
  const send = (text) => sendAs(userKey, text);

  context.after(async () => {
    await adminPool.query('DELETE FROM users WHERE whatsapp_id = ANY($1::text[])', [[userKey, otherUserKey]]);
  });
  return { userKey, otherUserKey, send, sendAs };
}

async function saveEntry(send, description = 'pagamento do serviço de teste', amount = '2.500,00') {
  const confirmation = await send('Recebi R$ ' + amount + ' ' + description);
  assert.match(confirmation, /Posso salvar\?/);
  assert.ok(confirmation.includes(description), 'A confirmação deve preservar a descrição');
  assert.match(await send('sim'), /Salvo:/);
  const listing = await send('listar');
  const id = listing.match(/#(\d+)/)?.[1];
  assert.ok(id, 'A listagem deve apresentar o ID do lançamento');
  return id;
}

async function readTransactionsAs(externalUserId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.user_key', externalUserId]);
    const result = await client.query('SELECT user_id::text, description FROM transactions');
    await client.query('COMMIT');
    return result.rows;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

test('banco de teste mantém papel app restrito e RLS forçado nas cinco tabelas', async () => {
  const appRole = await pool.query(`
    SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication,
           has_table_privilege(current_user, 'public.transactions', 'DELETE') AS can_delete_transactions,
           has_table_privilege(current_user, 'public.transaction_events', 'DELETE') AS can_delete_events,
           EXISTS (SELECT 1 FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace
             AND c.relkind = 'r' AND c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)) AS owns_app_tables
    FROM pg_roles WHERE rolname = current_user
  `);
  assert.deepEqual(appRole.rows[0], {
    rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false,
    rolreplication: false, can_delete_transactions: false,
    can_delete_events: false, owns_app_tables: false,
  }, 'A credencial do app de teste precisa manter privilégios mínimos');

  const rls = await adminPool.query(`
    SELECT count(*)::int AS table_count,
           count(*) FILTER (WHERE c.relrowsecurity)::int AS rls_count,
           count(*) FILTER (WHERE c.relforcerowsecurity)::int AS force_rls_count,
           count(*) FILTER (WHERE EXISTS (
             SELECT 1 FROM pg_policies p
             WHERE p.schemaname = n.nspname AND p.tablename = c.relname
               AND p.roles && ARRAY['anon', 'authenticated', 'public']::name[]
           ))::int AS public_policy_count
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
      AND c.relname = ANY($1::text[])
  `, [['users', 'pending_entries', 'transactions', 'pending_operations', 'transaction_events']]);
  assert.deepEqual(rls.rows[0], {
    table_count: 5, rls_count: 5, force_rls_count: 5, public_policy_count: 0,
  });
});

test('resumo e correção confirmada preservam descrição e isolamento entre perfis', async (context) => {
  const { userKey, otherUserKey, send, sendAs } = await fixture(context);
  const id = await saveEntry(send, 'pagamento referente ao salário de outubro, parcela 2');
  const listing = await send('listar');
  assert.match(listing, /pagamento referente ao salário de outubro, parcela 2/i);
  assert.match(await sendAs(otherUserKey, 'listar'), /Ainda não há lançamentos salvos/i);
  assert.match(await sendAs(otherUserKey, 'detalhe ' + id), /Não encontrei esse ID neste perfil/i);
  const otherSummary = await sendAs(otherUserKey, 'resumo mês');
  assert.match(otherSummary, /Entradas \(0\): R\$\s*0,00/);
  assert.doesNotMatch(otherSummary, /salário de outubro/i);

  assert.match(await send('corrigir ' + id + ' valor 2600'), /Confira a alteração/);
  assert.match(await send('descrição Pagamento corrigido do salário de outubro, parcela 2'), /Alteração preparada/);
  assert.match(await send('sim'), /Lançamento #\d+ atualizado/);
  assert.match(await send('detalhe ' + id), /R\$\s*2\.600,00/);
  const summary = await send('resumo mês');
  assert.match(summary, /Entradas \(1\): R\$\s*2\.600,00/);
  assert.match(summary, /Pagamento corrigido do salário de outubro, parcela 2/);
  assert.equal((await readTransactionsAs(userKey)).length, 1);
  assert.deepEqual(await readTransactionsAs(otherUserKey), []);
});

test('impede desfazer o ID de outro usuário', async (context) => {
  const { otherUserKey, send, sendAs } = await fixture(context);
  const id = await saveEntry(send);
  assert.match(await sendAs(otherUserKey, 'desfazer ' + id), /Não encontrei esse lançamento ativo neste perfil/);
  assert.match(await sendAs(otherUserKey, 'sim'), /Não há lançamento aguardando confirmação/);
  assert.doesNotMatch(await send('detalhe ' + id), /Revertido em:/);
});

test('desfazer duas vezes preserva uma única reversão no histórico', async (context) => {
  const { userKey, send } = await fixture(context);
  const id = await saveEntry(send);
  assert.match(await send('desfazer ' + id), /Confirma\?/);
  assert.match(await send('sim'), /marcado como revertido/);
  assert.match(await send('desfazer ' + id), /Não encontrei esse lançamento ativo neste perfil/);
  assert.match(await send('sim'), /Não há lançamento aguardando confirmação/);

  const record = await adminPool.query(`
    SELECT t.reversed_at, count(e.id) FILTER (WHERE e.event_type = 'reversed')::int AS reversals
    FROM transactions t JOIN users u ON u.id = t.user_id
    LEFT JOIN transaction_events e ON e.transaction_id = t.id
    WHERE u.whatsapp_id = $1 AND t.id = $2
    GROUP BY t.id
  `, [userKey, id]);
  assert.equal(record.rows[0]?.reversals, 1);
  assert.ok(record.rows[0]?.reversed_at);
});

test('impede corrigir o ID de outro usuário sem alterar o lançamento original', async (context) => {
  const { otherUserKey, send, sendAs, userKey } = await fixture(context);
  const id = await saveEntry(send);
  assert.match(await sendAs(otherUserKey, 'corrigir ' + id + ' valor 9999'), /Não encontrei esse lançamento ativo/);
  assert.match(await sendAs(otherUserKey, 'sim'), /Não há lançamento aguardando confirmação/);
  assert.match(await send('detalhe ' + id), /R\$\s*2\.500,00/);
  const audit = await adminPool.query(`
    SELECT count(*)::int AS events
    FROM transaction_events e JOIN users u ON u.id = e.user_id
    WHERE u.whatsapp_id = $1 AND e.transaction_id = $2
  `, [userKey, id]);
  assert.equal(audit.rows[0]?.events, 1);
});

test('RLS bloqueia INSERT com user_id trocado', async (context) => {
  const { userKey, otherUserKey, send } = await fixture(context);
  const id = await saveEntry(send);
  const foreignOwnerId = (await readTransactionsAs(userKey))[0].user_id;
  const client = await pool.connect();
  let insertError;
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.user_key', otherUserKey]);
    try {
      await client.query(
        `INSERT INTO transactions (user_id, entry_type, amount_cents, category, source_message_id)
         VALUES ($1, 'income', 100, 'Teste', $2)`,
        [foreignOwnerId, 'cross-user:' + randomUUID()],
      );
    } catch (error) { insertError = error; }
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
  assert.equal(insertError?.code, '42501', 'RLS deve bloquear INSERT associado a outro perfil');
  assert.match(await send('detalhe ' + id), /pagamento do serviço de teste/i);
});

test('auditoria registra criação, correção e reversão', async (context) => {
  const { userKey, send } = await fixture(context);
  const id = await saveEntry(send, 'serviço auditável de teste', '150,00');
  assert.match(await send('corrigir ' + id + ' valor 175'), /Confira a alteração/);
  assert.match(await send('sim'), /Lançamento #\d+ atualizado/);
  assert.match(await send('desfazer ' + id), /Confirma\?/);
  assert.match(await send('sim'), /marcado como revertido/);

  const events = await adminPool.query(`
    SELECT e.event_type
    FROM transaction_events e JOIN users u ON u.id = e.user_id
    WHERE u.whatsapp_id = $1 ORDER BY e.id
  `, [userKey]);
  assert.deepEqual(events.rows.map((row) => row.event_type), ['created', 'updated', 'reversed']);
});
