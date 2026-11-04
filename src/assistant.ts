import type { Pool } from 'pg';

export type AssistantMessage = { userId: string; messageId: string; text: string };
type EntryType = 'income' | 'expense';
type Entry = { type: EntryType; cents: number; category: string; description: string };
type Period = { start: string; end: string; label: string };
type Transaction = {
  id: string; entry_type: EntryType; amount_cents: string; category: string;
  description: string | null; occurred_at: string; created_at?: string; reversed_at?: string | null;
};
type Editable = Pick<Transaction, 'entry_type' | 'amount_cents' | 'category' | 'description' | 'occurred_at'>;

export async function handleAssistantMessage(pool: Pool, message: AssistantMessage): Promise<string> {
  const text = message.text.trim();
  const normalized = text.toLocaleLowerCase('pt-BR');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.user_key', $1, true)", [message.userId]);
    const userResult = await client.query<{ id: string; timezone: string }>(
      `INSERT INTO users (whatsapp_id) VALUES ($1)
       ON CONFLICT (whatsapp_id) DO UPDATE SET whatsapp_id = EXCLUDED.whatsapp_id
       RETURNING id, timezone`, [message.userId],
    );
    const userId = userResult.rows[0].id;
    const timezone = userResult.rows[0].timezone;

    if (['/start', '/ajuda', 'ajuda'].includes(normalized)) {
      await client.query('COMMIT');
      return 'Olá! Sou seu Assistente de Caixa. Registre uma entrada (ex.: “recebi 150 pelo corte da Ana”) ou saída (ex.: “gastei 20 com gasolina”). Eu mostro os dados para confirmar antes de salvar. Digite /help para ver os comandos.';
    }
    if (['/help', 'ajuda comandos'].includes(normalized)) {
      await client.query('COMMIT');
      return 'Comandos: “resumo mês”, “resumo hoje”, “listar”, “detalhe ID”, “corrigir ID”, “alterar”, “desfazer” e “cancelar”. Confirme uma operação com “sim”.';
    }

    if (/^(cancelar|cancela|não|nao)$/i.test(normalized)) {
      const removed = await client.query('DELETE FROM pending_entries WHERE user_id = $1', [userId]);
      await client.query('DELETE FROM pending_operations WHERE user_id = $1', [userId]);
      await client.query('COMMIT');
      return removed.rowCount ? 'Tudo bem, descartei o lançamento pendente. Nada foi salvo.' : 'Operação cancelada. Nenhuma alteração foi feita.';
    }

    const undoCommand = text.match(/^(?:desfazer|desfaz)(?:\s+(\d+))?$/i);
    if (undoCommand) {
      const pending = await client.query('SELECT 1 FROM pending_operations WHERE user_id = $1', [userId]);
      if (pending.rowCount) { await client.query('COMMIT'); return 'Há uma alteração aguardando. Responda “sim” ou “cancelar” primeiro.'; }
      if (!undoCommand[1]) {
        const recent = await client.query<Transaction>(
          `SELECT id::text, entry_type, amount_cents::text, category, description, occurred_at::text
           FROM transactions WHERE user_id = $1 AND reversed_at IS NULL
           ORDER BY created_at DESC, id DESC LIMIT 10`, [userId],
        );
        await client.query('COMMIT');
        return recent.rowCount
          ? `Qual lançamento quer desfazer? Envie “desfazer ID” e confira antes de confirmar:\n${recent.rows.map((entry) => formatTransaction(entry, timezone)).join('\n')}`
          : 'Ainda não há lançamento salvo para desfazer.';
      }
      const selected = await client.query<Transaction>(
        `SELECT id::text, entry_type, amount_cents::text, category, description, occurred_at::text, created_at::text
         FROM transactions WHERE user_id = $1 AND id = $2 AND reversed_at IS NULL FOR UPDATE`, [userId, undoCommand[1]],
      );
      if (!selected.rowCount) { await client.query('COMMIT'); return 'Não encontrei esse lançamento ativo neste perfil. Digite “desfazer” para ver os IDs disponíveis.'; }
      const entry = selected.rows[0];
      await client.query(
        `INSERT INTO pending_operations (user_id, transaction_id, operation_type, changes)
         VALUES ($1, $2, 'reverse', '{}'::jsonb)
         ON CONFLICT (user_id) DO UPDATE SET transaction_id = EXCLUDED.transaction_id,
           operation_type = EXCLUDED.operation_type, changes = EXCLUDED.changes, created_at = now()`, [userId, entry.id],
      );
      await client.query('COMMIT');
      return `Vou desfazer este lançamento:\n${formatTransaction(entry, timezone)}\nConfirma? Responda “sim” para reverter ou “cancelar” para manter.`;
    }

    if (/^(alterar|altera|corrigir|corrige)$/i.test(normalized)) {
      const recent = await client.query<Transaction>(
        `SELECT id::text, entry_type, amount_cents::text, category, description, occurred_at::text
         FROM transactions WHERE user_id = $1 AND reversed_at IS NULL ORDER BY created_at DESC, id DESC LIMIT 5`, [userId],
      );
      await client.query('COMMIT');
      return recent.rowCount
        ? `Qual lançamento quer alterar? Envie o ID:\n${recent.rows.map((row) => formatTransaction(row, timezone)).join('\n')}`
        : 'Ainda não há lançamentos salvos para alterar.';
    }

    const correction = text.match(/^(?:corrigir|corrige|alterar|altera)\s+(\d+)(?:\s+(valor|categoria|descri(?:ção|cao)|tipo)\s+(.+))?$/i);
    if (correction) {
      const existing = await client.query('SELECT 1 FROM pending_operations WHERE user_id = $1', [userId]);
      if (existing.rowCount) { await client.query('COMMIT'); return 'Já existe uma operação aguardando. Responda “sim” ou “cancelar”.'; }
      const result = await client.query<Transaction>(
        `SELECT id::text, entry_type, amount_cents::text, category, description, occurred_at::text
         FROM transactions WHERE user_id = $1 AND id = $2 AND reversed_at IS NULL FOR UPDATE`, [userId, correction[1]],
      );
      if (!result.rowCount) { await client.query('COMMIT'); return 'Não encontrei esse lançamento ativo. Digite “listar” para ver os IDs.'; }
      const old = result.rows[0];
      const changes: Editable = { entry_type: old.entry_type, amount_cents: old.amount_cents,
        category: old.category, description: old.description, occurred_at: old.occurred_at };
      if (correction[2] && !applyField(changes, correction[2], correction[3])) {
        await client.query('COMMIT'); return 'Não entendi o novo valor. Use valor, categoria, descrição ou tipo.';
      }
      await client.query(
        `INSERT INTO pending_operations (user_id, transaction_id, operation_type, changes)
         VALUES ($1, $2, 'edit', $3::jsonb)
         ON CONFLICT (user_id) DO UPDATE SET transaction_id = EXCLUDED.transaction_id,
           operation_type = EXCLUDED.operation_type, changes = EXCLUDED.changes, created_at = now()`,
        [userId, old.id, JSON.stringify(changes)],
      );
      await client.query('COMMIT');
      return `Lançamento #${old.id}:\n${formatTransaction(old, timezone)}\n${correction[2] ? 'Confira a alteração.' : 'Envie o campo que quer mudar, por exemplo “valor 130” ou “descrição diária da Ana”.'}\n${formatEditable(changes)}\nResponda “sim” para salvar ou “cancelar” para manter como estava.`;
    }

    const field = text.match(/^(valor|categoria|descri(?:ção|cao)|tipo)\s+(.+)$/i);
    if (field) {
      const operation = await client.query<{ operation_type: string; changes: Editable }>(
        'SELECT operation_type, changes FROM pending_operations WHERE user_id = $1 FOR UPDATE', [userId],
      );
      if (operation.rowCount && operation.rows[0].operation_type === 'edit') {
        const changes = operation.rows[0].changes;
        if (!applyField(changes, field[1], field[2])) { await client.query('COMMIT'); return 'Não entendi esse campo. Use “valor 130”, “categoria Transporte” ou “descrição corte da Ana”.'; }
        await client.query('UPDATE pending_operations SET changes = $2::jsonb WHERE user_id = $1', [userId, JSON.stringify(changes)]);
        await client.query('COMMIT');
        return `Alteração preparada:\n${formatEditable(changes)}\nResponda “sim” para salvar ou “cancelar” para manter como estava.`;
      }
      if (operation.rowCount) { await client.query('COMMIT'); return 'Há um desfazer aguardando confirmação. Responda “sim” ou “cancelar”.'; }
    }

    if (['sim', 'confirmo', 'pode salvar', 'salvar'].includes(normalized)) {
      const operationResult = await client.query<{ transaction_id: string; operation_type: 'edit' | 'reverse'; changes: Editable }>(
        'SELECT transaction_id::text, operation_type, changes FROM pending_operations WHERE user_id = $1 FOR UPDATE', [userId],
      );
      if (operationResult.rowCount) {
        const op = operationResult.rows[0];
        const current = await client.query<Transaction>(
          `SELECT id::text, entry_type, amount_cents::text, category, description, occurred_at::text
           FROM transactions WHERE id = $1 AND user_id = $2 AND reversed_at IS NULL FOR UPDATE`, [op.transaction_id, userId],
        );
        if (!current.rowCount) { await client.query('DELETE FROM pending_operations WHERE user_id = $1', [userId]); await client.query('COMMIT'); return 'O lançamento não está mais ativo; cancelei a operação sem alterar o histórico.'; }
        const before = current.rows[0];
        if (op.operation_type === 'reverse') {
          await client.query('UPDATE transactions SET reversed_at = now(), updated_at = now() WHERE id = $1 AND user_id = $2', [op.transaction_id, userId]);
          await client.query(`INSERT INTO transaction_events (user_id, transaction_id, event_type, before_data, after_data)
            VALUES ($1, $2, 'reversed', $3::jsonb, jsonb_build_object('reversed_at', now()))`, [userId, op.transaction_id, JSON.stringify(before)]);
          await client.query('DELETE FROM pending_operations WHERE user_id = $1', [userId]); await client.query('COMMIT');
          return `Desfeito: o lançamento #${before.id} foi marcado como revertido e removido dos resumos. O histórico foi preservado.`;
        }
        const updated = await client.query<Transaction>(
          `UPDATE transactions SET entry_type=$3, amount_cents=$4, category=$5, description=$6, occurred_at=$7::timestamptz, updated_at=now()
           WHERE id=$1 AND user_id=$2 RETURNING id::text, entry_type, amount_cents::text, category, description, occurred_at::text`,
          [op.transaction_id, userId, op.changes.entry_type, op.changes.amount_cents, op.changes.category, op.changes.description, op.changes.occurred_at],
        );
        await client.query(`INSERT INTO transaction_events (user_id, transaction_id, event_type, before_data, after_data)
          VALUES ($1, $2, 'updated', $3::jsonb, $4::jsonb)`, [userId, op.transaction_id, JSON.stringify(before), JSON.stringify(updated.rows[0])]);
        await client.query('DELETE FROM pending_operations WHERE user_id = $1', [userId]); await client.query('COMMIT');
        return `Lançamento #${updated.rows[0].id} atualizado.\nAntes: ${formatTransaction(before, timezone)}\nAgora: ${formatTransaction(updated.rows[0], timezone)}`;
      }

      const pending = await client.query<any>('SELECT * FROM pending_entries WHERE user_id = $1 FOR UPDATE', [userId]);
      if (!pending.rowCount) { await client.query('COMMIT'); return 'Não há lançamento aguardando confirmação. Mande, por exemplo: “recebi 150 pelo corte da Ana”.'; }
      const row = pending.rows[0];
      const inserted = await client.query<Transaction>(
        `INSERT INTO transactions (user_id, entry_type, amount_cents, category, description, service_minutes, source_message_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (user_id, source_message_id) DO NOTHING
         RETURNING id::text, entry_type, amount_cents::text, category, description, occurred_at::text`,
        [userId, row.entry_type, row.amount_cents, row.category, row.description, row.service_minutes, row.source_message_id],
      );
      if (inserted.rowCount) await client.query(`INSERT INTO transaction_events (user_id, transaction_id, event_type, after_data)
        VALUES ($1, $2, 'created', $3::jsonb)`, [userId, inserted.rows[0].id, JSON.stringify(inserted.rows[0])]);
      await client.query('DELETE FROM pending_entries WHERE user_id = $1', [userId]); await client.query('COMMIT');
      return `Salvo: ${row.entry_type === 'income' ? 'entrou' : 'saiu'} ${money(Number(row.amount_cents))} (${label(row.category, row.description)}).`;
    }

    if (/^(?:resumo|saldo|quanto sobrou\??|lucro)\b/i.test(normalized)) {
      const period = resolveSummaryPeriod(text, timezone);
      if (!period) { await client.query('COMMIT'); return 'Período não reconhecido. Tente “resumo hoje”, “resumo semana” ou “resumo mês”.'; }
      const entries = await client.query<Transaction>(
        `SELECT t.id::text,t.entry_type,t.amount_cents::text,t.category,t.description,t.occurred_at::text,t.created_at::text
         FROM transactions t JOIN users u ON u.id=t.user_id WHERE t.user_id=$1 AND t.reversed_at IS NULL
         AND (t.occurred_at AT TIME ZONE u.timezone)::date BETWEEN $2::date AND $3::date
         ORDER BY t.occurred_at DESC,t.id DESC`, [userId, period.start, period.end],
      );
      await client.query('COMMIT'); return buildSummary(entries.rows, period, timezone);
    }

    if (['listar', 'histórico', 'historico'].includes(normalized)) {
      const entries = await client.query<Transaction>(
        `SELECT id::text,entry_type,amount_cents::text,category,description,occurred_at::text
         FROM transactions WHERE user_id=$1 AND reversed_at IS NULL ORDER BY created_at DESC,id DESC LIMIT 10`, [userId],
      );
      await client.query('COMMIT'); return entries.rowCount ? `Últimos lançamentos:\n${entries.rows.map((r) => formatTransaction(r, timezone)).join('\n')}` : 'Ainda não há lançamentos salvos.';
    }
    const detail = text.match(/^detalhe\s+(\d+)$/i);
    if (detail) {
      const entry = await client.query<Transaction>(`SELECT id::text,entry_type,amount_cents::text,category,description,occurred_at::text,reversed_at::text
        FROM transactions WHERE user_id=$1 AND id=$2`, [userId, detail[1]]);
      await client.query('COMMIT'); return entry.rowCount
        ? `${formatTransaction(entry.rows[0], timezone)}${entry.rows[0].reversed_at ? `\nRevertido em: ${date(entry.rows[0].reversed_at, timezone)}` : ''}`
        : 'Não encontrei esse ID neste perfil.';
    }

    const draft = parseEntry(text);
    if (!draft) { await client.query('COMMIT'); return 'Pode mandar assim: “recebi 150 pelo corte da Ana” ou “gastei 20 com gasolina”. Eu mostro valor, categoria e descrição para confirmar antes de salvar.'; }
    await client.query(
      `INSERT INTO pending_entries (user_id,entry_type,amount_cents,category,description,source_message_id)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (user_id) DO UPDATE SET entry_type=EXCLUDED.entry_type,
       amount_cents=EXCLUDED.amount_cents,category=EXCLUDED.category,description=EXCLUDED.description,
       source_message_id=EXCLUDED.source_message_id,created_at=now()`,
      [userId, draft.type, draft.cents, draft.category, draft.description, message.messageId],
    );
    await client.query('COMMIT');
    return `Entendi: ${draft.type === 'income' ? 'entrou' : 'saiu'} ${money(draft.cents)} (${label(draft.category, draft.description)}). Posso salvar? Responda “sim” ou “cancelar”.`;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

export function parseEntryText(text: string) { return parseEntry(text); }
function parseEntry(text: string): Entry | null {
  const match = text.match(/(?:r\$\s*)((?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d{1,2}|\.\d{1,2})?)/i) ?? text.match(/((?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d{1,2}|\.\d{1,2})?)/i);
  if (!match) return null;
  const raw = match[1]; const value = Number(raw.includes(',') ? raw.replace(/\./g,'').replace(',','.') : /^\d{1,3}(?:\.\d{3})+$/.test(raw) ? raw.replace(/\./g,'') : raw);
  if (!Number.isFinite(value) || value <= 0) return null;
  const lower = text.toLocaleLowerCase('pt-BR');
  const income = /\b(recebi|entrou|ganhei|vendi|pagaram)\b/.test(lower), expense = /\b(gastei|paguei|saiu|comprei|despesa)\b/.test(lower);
  if (income === expense) return null;
  const type: EntryType = income ? 'income' : 'expense';
  const category = categoryFrom(lower, type);
  const description = `${text.slice(0, match.index ?? 0)} ${text.slice((match.index ?? 0) + match[0].length)}`
    .replace(/\b(recebi|entrou|ganhei|vendi|pagaram|gastei|paguei|saiu|comprei|despesa)\b/ig,' ')
    .replace(/^\s*(?:de|do|da|dos|das|com|por|para)\s+/i,' ')
    .replace(/\s+/g,' ').replace(/^[\s,;:.-]+|[\s,;:.-]+$/g,'').trim().slice(0,240);
  return { type, cents: Math.round(value*100), category, description };
}
function categoryFrom(text: string, type: EntryType) {
  const rules: Array<[RegExp,string]> = [[/sal[aá]rio|pagamento/,'Salário'],[/combust[ií]vel|gasolina|etanol|diesel/,'Combustível'],[/material|cimento|ferramenta|peça/,'Material'],[/corte|manicure|unha|barba|cabelo/,'Serviço'],[/diária|diaria|faxina|limpeza/,'Diária'],[/transporte|uber|corrida|ônibus/,'Transporte'],[/lanche|comida|mercado/,'Alimentação']];
  return rules.find(([re])=>re.test(text))?.[1] ?? (type==='income'?'Serviço':'Gasto');
}
function applyField(entry: Editable, field: string, value: string) {
  if (/^valor$/i.test(field)) { const amount = parseAmount(value); if (!amount) return false; entry.amount_cents=String(amount); return true; }
  if (/^categoria$/i.test(field)) { entry.category=value.trim().slice(0,80); return !!entry.category; }
  if (/^descri/i.test(field)) { entry.description=value.trim().slice(0,240)||null; return true; }
  if (/^tipo$/i.test(field)) { const v=value.toLocaleLowerCase('pt-BR'); if (['entrada','receita'].includes(v)) entry.entry_type='income'; else if (['saída','saida','despesa'].includes(v)) entry.entry_type='expense'; else return false; return true; }
  return false;
}
function parseAmount(text: string) { const entry=parseEntry(`recebi ${text}`); return entry?.cents ?? null; }
function formatTransaction(e: Transaction, tz: string) { return `#${e.id} ${e.entry_type==='income'?'+':'−'} ${money(Number(e.amount_cents))} | ${e.category} | ${e.description?.trim()||'Descrição não informada'} | ${date(e.occurred_at,tz)}`; }
function formatEditable(e: Editable) { return `${e.entry_type==='income'?'Entrada':'Saída'}: ${money(Number(e.amount_cents))} | ${e.category} | ${e.description||'Descrição não informada'}`; }
function label(category: string, description: string|null) { return description?.trim() ? `${category} — ${description.trim()}` : category; }
type SummaryPeriod = Period;
export function resolveSummaryPeriod(request: string, timezone='America/Bahia', now=new Date()): SummaryPeriod|null {
  const value=request.trim().replace(/^(?:resumo|saldo|quanto sobrou\??|lucro)\s*/i,'').replace(/^(?:de|do|da|no|na|neste|nesta)\s+/i,'').trim().toLocaleLowerCase('pt-BR');
  const today=dateInTimezone(now,timezone);
  if (!value||['mês','mes','este mês','este mes','mensal'].includes(value)) return {start:`${today.slice(0,7)}-01`,end:today,label:'Este mês'};
  if (['hoje','diário','diario'].includes(value)) return {start:today,end:today,label:'Hoje'};
  if (['semana','esta semana','essa semana'].includes(value)) { const wd=new Date(`${today}T12:00:00Z`).getUTCDay(); const start=shiftDate(today,-((wd+6)%7)); return {start,end:today,label:'Esta semana'}; }
  const custom=value.match(/^(\d{4}-\d{2}-\d{2}|\d{2}\/\d{2}\/\d{4})\s+(?:até|ate|a)\s+(\d{4}-\d{2}-\d{2}|\d{2}\/\d{2}\/\d{4})$/i);
  if(custom){const start=normalDate(custom[1]),end=normalDate(custom[2]);if(!start||!end||start>end)return null;return {start,end,label:`${start} a ${end}`};} return null;
}
export function buildSummary(entries: Transaction[], period: Period, timezone='America/Bahia') {
  const ins=entries.filter(e=>e.entry_type==='income'),outs=entries.filter(e=>e.entry_type==='expense');
  const income=ins.reduce((n,e)=>n+Number(e.amount_cents),0),expense=outs.reduce((n,e)=>n+Number(e.amount_cents),0);
  const cats=new Map<string,number>(); for(const e of outs)cats.set(e.category,(cats.get(e.category)||0)+Number(e.amount_cents));
  const top=[...cats].sort((a,b)=>b[1]-a[1])[0];
  const lines=[`RESUMO — ${period.label.toLocaleUpperCase('pt-BR')}`,`Período: ${date(`${period.start}T12:00:00Z`,timezone)} a ${date(`${period.end}T12:00:00Z`,timezone)}`,'','VISÃO GERAL',`Entradas (${ins.length}): ${money(income)}`,`Saídas (${outs.length}): ${money(expense)}`,`Lançamentos ativos: ${entries.length}`,`Saldo registrado: ${money(income-expense)}`];
  lines.push(income>expense?`Entradas superaram as saídas em ${money(income-expense)}.`:expense>income?`Saídas superaram as entradas em ${money(expense-income)}.`:entries.length?'Entradas e saídas ficaram no mesmo valor.':'Ainda não há movimentações neste período.');
  if(top)lines.push(`Categoria com maior saída: ${top[0]} (${money(top[1])}).`);
  lines.push('','ENTRADAS:',...summaryLines(ins,timezone),`Total de entradas: ${money(income)}.`,'','SAÍDAS:',...summaryLines(outs,timezone),`Total de saídas: ${money(expense)}.`,'','O saldo considera apenas lançamentos ativos registrados; não é lucro contábil.');
  return lines.join('\n');
}
function summaryLines(rows: Transaction[],tz: string) { return rows.length?rows.slice(0,5).map(e=>`• ${money(Number(e.amount_cents))} | ${e.category} | ${e.description||'Descrição não informada'} | ${date(e.occurred_at,tz)}`):['• Nenhum lançamento.']; }
function money(cents:number){return new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(cents/100);}
function date(value:string,tz:string){return new Intl.DateTimeFormat('pt-BR',{timeZone:tz,day:'2-digit',month:'2-digit',year:'numeric'}).format(new Date(value));}
function dateInTimezone(d:Date,tz:string){const p=new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(d);const g=(t:string)=>p.find(x=>x.type===t)?.value??'';return `${g('year')}-${g('month')}-${g('day')}`;}
function shiftDate(value:string,n:number){const d=new Date(`${value}T12:00:00Z`);d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);}
function normalDate(v:string){const d=v.includes('/')?v.split('/').reverse().join('-'):v;const parsed=new Date(`${d}T00:00:00Z`);return Number.isNaN(parsed.getTime())||parsed.toISOString().slice(0,10)!==d?null:d;}
