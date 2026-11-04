import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { handleAssistantMessage } from '../dist/assistant.js';

test('persistência, correção confirmada, resumo e reversão auditada no PostgreSQL', async () => {
  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL não está configurada no .env');
  assert.ok(process.env.DATABASE_ADMIN_URL, 'DATABASE_ADMIN_URL deve estar configurada em .env.admin para preparar e limpar dados de teste');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const adminPool = new Pool({ connectionString: process.env.DATABASE_ADMIN_URL, max: 1 });
  const userKey = `integration-test:${randomUUID()}`;
  const otherUserKey = `integration-test-other:${randomUUID()}`;
  let messageNumber = 0;
  let schemaReady = false;
  const sendAs = (userId, text) => handleAssistantMessage(pool, {
    userId,
    messageId: `${userId}:${++messageNumber}`,
    text,
  });
  const send = (text) => sendAs(userKey, text);

  try {
    const schema = await adminPool.query(`
      SELECT to_regclass('public.pending_operations') IS NOT NULL AS pending_operations,
             to_regclass('public.transaction_events') IS NOT NULL AS transaction_events,
             EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema = 'public' AND table_name = 'transactions'
                 AND column_name = 'reversed_at') AS reversed_at
    `);
    assert.deepEqual(schema.rows[0], {
      pending_operations: true, transaction_events: true, reversed_at: true,
    }, 'Aplique o database/schema.sql atualizado antes do teste integrado');
    schemaReady = true;

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
    }, 'A credencial do backend deve ter privilégios mínimos e não pode ignorar RLS');

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
    }, 'As cinco tabelas devem manter RLS ativo e sem políticas abertas à API pública');

    const confirmation = await send('Recebi R$ 2.500,00 pagamento referente ao salário de outubro, parcela 2');
    assert.match(confirmation, /R\$\s*2\.500,00/);
    assert.match(confirmation, /pagamento referente ao salário de outubro, parcela 2/i);

    assert.match(await send('sim'), /Salvo:/);
    const listing = await send('listar');
    assert.match(listing, /pagamento referente ao salário de outubro, parcela 2/i);
    const id = listing.match(/#(\d+)/)?.[1];
    assert.ok(id, 'A listagem deve apresentar o ID do lançamento');
    assert.match(await sendAs(otherUserKey, 'listar'), /Ainda não há lançamentos salvos/i);
    assert.match(await sendAs(otherUserKey, `detalhe ${id}`), /Não encontrei esse ID neste perfil/i);
    const otherSummary = await sendAs(otherUserKey, 'resumo mês');
    assert.match(otherSummary, /Entradas \(0\): R\$\s*0,00/);
    assert.doesNotMatch(otherSummary, /pagamento referente ao salário de outubro/i);

    const readTransactionsAs = async (externalUserId) => {
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
      } finally { client.release(); }
    };
    assert.equal((await readTransactionsAs(userKey)).length, 1, 'O perfil deve ler seu lançamento mesmo sem filtro SQL por user_id');
    assert.deepEqual(await readTransactionsAs(otherUserKey), [], 'RLS deve ocultar linhas alheias mesmo sem filtro SQL por user_id');
    const foreignOwnerId = (await readTransactionsAs(userKey))[0].user_id;
    const crossInsertClient = await pool.connect();
    let crossInsertError;
    try {
      await crossInsertClient.query('BEGIN');
      await crossInsertClient.query('SELECT set_config($1, $2, true)', ['app.user_key', otherUserKey]);
      try {
        await crossInsertClient.query(
          `INSERT INTO transactions (user_id, entry_type, amount_cents, category, source_message_id)
           VALUES ($1, 'income', 100, 'Teste', $2)`,
          [foreignOwnerId, `cross-user:${randomUUID()}`],
        );
      } catch (error) { crossInsertError = error; }
      await crossInsertClient.query('ROLLBACK');
    } finally { crossInsertClient.release(); }
    assert.equal(crossInsertError?.code, '42501', 'RLS deve bloquear INSERT associado a outro perfil');
    assert.match(await sendAs(otherUserKey, `corrigir ${id}`), /Não encontrei esse lançamento/i);
    assert.match(await sendAs(otherUserKey, `desfazer ${id}`), /Não encontrei esse lançamento/i);

    assert.match(await send(`corrigir ${id} valor 2600`), /Confira a alteração/);
    assert.match(await send('descrição Pagamento corrigido do salário de outubro, parcela 2'), /Alteração preparada/);
    assert.match(await send('sim'), /Lançamento #\d+ atualizado/);

    const details = await send(`detalhe ${id}`);
    assert.match(details, /R\$\s*2\.600,00/);
    assert.match(details, /Pagamento corrigido do salário de outubro, parcela 2/);

    const summary = await send('resumo mês');
    assert.match(summary, /Entradas \(1\): R\$\s*2\.600,00/);
    assert.match(summary, /Pagamento corrigido do salário de outubro, parcela 2/);

    assert.match(await send('Gastei R$ 40,00 com transporte para buscar material'), /R\$\s*40,00/);
    assert.match(await send('sim'), /Salvo:/);
    assert.match(await send('desfazer'), new RegExp(`#${id} `));
    assert.match(await send(`desfazer ${id}`), /Confirma\?/);
    assert.match(await send('sim'), /marcado como revertido/);
    assert.match(await send(`detalhe ${id}`), /Revertido em:/);
    const remainingSummary = await send('resumo mês');
    assert.match(remainingSummary, /Entradas \(0\): R\$\s*0,00/);
    assert.match(remainingSummary, /Saídas \(1\): R\$\s*40,00/);
    assert.match(remainingSummary, /transporte para buscar material/i);

    const events = await adminPool.query(
      `SELECT event_type FROM transaction_events e JOIN users u ON u.id = e.user_id
       WHERE u.whatsapp_id = $1 ORDER BY e.id`, [userKey],
    );
    assert.deepEqual(events.rows.map((row) => row.event_type), ['created', 'updated', 'created', 'reversed']);
  } finally {
    if (schemaReady) {
      await adminPool.query('DELETE FROM transaction_events WHERE user_id IN (SELECT id FROM users WHERE whatsapp_id = ANY($1::text[]))', [[userKey, otherUserKey]]);
      await adminPool.query('DELETE FROM pending_operations WHERE user_id IN (SELECT id FROM users WHERE whatsapp_id = ANY($1::text[]))', [[userKey, otherUserKey]]);
      await adminPool.query('DELETE FROM pending_entries WHERE user_id IN (SELECT id FROM users WHERE whatsapp_id = ANY($1::text[]))', [[userKey, otherUserKey]]);
      await adminPool.query('DELETE FROM transactions WHERE user_id IN (SELECT id FROM users WHERE whatsapp_id = ANY($1::text[]))', [[userKey, otherUserKey]]);
      await adminPool.query('DELETE FROM users WHERE whatsapp_id = ANY($1::text[])', [[userKey, otherUserKey]]);
    }
    await pool.end();
    await adminPool.end();
  }
});
