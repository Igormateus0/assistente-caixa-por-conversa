import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { handleAssistantMessage } from '../dist/assistant.js';

test('persistência, correção confirmada, resumo e reversão auditada no PostgreSQL', async () => {
  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL não está configurada no .env');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
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
    const schema = await pool.query(`
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

    const confirmation = await send('Recebi R$ 2.500,00 pagamento referente ao salário de outubro, parcela 2');
    assert.match(confirmation, /R\$\s*2\.500,00/);
    assert.match(confirmation, /pagamento referente ao salário de outubro, parcela 2/i);

    assert.match(await send('sim'), /Salvo:/);
    const listing = await send('listar');
    assert.match(listing, /pagamento referente ao salário de outubro, parcela 2/i);
    const id = listing.match(/#(\d+)/)?.[1];
    assert.ok(id, 'A listagem deve apresentar o ID do lançamento');
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

    const events = await pool.query(
      `SELECT event_type FROM transaction_events e JOIN users u ON u.id = e.user_id
       WHERE u.whatsapp_id = $1 ORDER BY e.id`, [userKey],
    );
    assert.deepEqual(events.rows.map((row) => row.event_type), ['created', 'updated', 'created', 'reversed']);
  } finally {
    if (schemaReady) {
      await pool.query('DELETE FROM transaction_events WHERE user_id IN (SELECT id FROM users WHERE whatsapp_id = ANY($1::text[]))', [[userKey, otherUserKey]]);
      await pool.query('DELETE FROM pending_operations WHERE user_id IN (SELECT id FROM users WHERE whatsapp_id = ANY($1::text[]))', [[userKey, otherUserKey]]);
      await pool.query('DELETE FROM pending_entries WHERE user_id IN (SELECT id FROM users WHERE whatsapp_id = ANY($1::text[]))', [[userKey, otherUserKey]]);
      await pool.query('DELETE FROM transactions WHERE user_id IN (SELECT id FROM users WHERE whatsapp_id = ANY($1::text[]))', [[userKey, otherUserKey]]);
      await pool.query('DELETE FROM users WHERE whatsapp_id = ANY($1::text[])', [[userKey, otherUserKey]]);
    }
    await pool.end();
  }
});
