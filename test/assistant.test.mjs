import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSummary, parseEntryText, resolveSummaryPeriod } from '../dist/assistant.js';

test('interpreta valores brasileiros e preserva números que fazem parte da descrição', () => {
  const entry = parseEntryText('Recebi R$ 2.500,00 pagamento referente ao salário de outubro, parcela 2');

  assert.ok(entry);
  assert.equal(entry.type, 'income');
  assert.equal(entry.cents, 250_000);
  assert.equal(entry.category, 'Salário');
  assert.equal(entry.description, 'pagamento referente ao salário de outubro, parcela 2');
});

test('identifica despesas e mantém o contexto informado', () => {
  const entry = parseEntryText('Gastei 120,50 com transporte, corrida 42');

  assert.ok(entry);
  assert.equal(entry.type, 'expense');
  assert.equal(entry.cents, 12_050);
  assert.equal(entry.category, 'Transporte');
  assert.equal(entry.description, 'transporte, corrida 42');
});

test('recusa valor zero, texto sem tipo e mensagem ambígua', () => {
  assert.equal(parseEntryText('recebi 0 por serviço'), null);
  assert.equal(parseEntryText('150 por serviço'), null);
  assert.equal(parseEntryText('recebi 150 e gastei 20'), null);
});

test('interpreta valores inteiros com quatro ou mais dígitos sem separador', () => {
  assert.equal(parseEntryText('recebi 2600 por serviço')?.cents, 260_000);
});

test('resolve períodos hoje, semana, mês e datas personalizadas', () => {
  const now = new Date('2026-11-02T16:00:00.000Z');
  assert.deepEqual(resolveSummaryPeriod('resumo hoje', 'America/Bahia', now), {
    start: '2026-11-02', end: '2026-11-02', label: 'Hoje',
  });
  assert.deepEqual(resolveSummaryPeriod('resumo semana', 'America/Bahia', now), {
    start: '2026-11-02', end: '2026-11-02', label: 'Esta semana',
  });
  assert.deepEqual(resolveSummaryPeriod('resumo mês', 'America/Bahia', now), {
    start: '2026-11-01', end: '2026-11-02', label: 'Este mês',
  });
  assert.deepEqual(resolveSummaryPeriod('resumo 01/10/2026 até 31/10/2026', 'America/Bahia', now), {
    start: '2026-10-01', end: '2026-10-31', label: '2026-10-01 a 2026-10-31',
  });
  assert.equal(resolveSummaryPeriod('resumo 2026-11-03 até 2026-11-01', 'America/Bahia', now), null);
});

test('monta resumo com contagem, saldo em centavos, categoria principal e descrições', () => {
  const summary = buildSummary([
    {
      id: '1', entry_type: 'income', amount_cents: '250000', category: 'Salário',
      description: 'Pagamento referente ao salário de outubro', occurred_at: '2026-11-02T12:00:00.000Z',
    },
    {
      id: '2', entry_type: 'expense', amount_cents: '45000', category: 'Alimentação',
      description: 'Compras do supermercado', occurred_at: '2026-11-02T13:00:00.000Z',
    },
    {
      id: '3', entry_type: 'expense', amount_cents: '12000', category: 'Transporte',
      description: 'Gastos com deslocamento', occurred_at: '2026-11-02T14:00:00.000Z',
    },
  ], { start: '2026-11-01', end: '2026-11-02', label: 'Este mês' });
  const plainSummary = summary.replace(/\s/g, ' ');

  assert.match(plainSummary, /Entradas \(1\): R\$ 2\.500,00/);
  assert.match(plainSummary, /Saídas \(2\): R\$ 570,00/);
  assert.match(plainSummary, /Saldo registrado: R\$ 1\.930,00/);
  assert.match(plainSummary, /Categoria com maior saída: Alimentação/);
  assert.match(plainSummary, /Pagamento referente ao salário de outubro/);
  assert.match(plainSummary, /Gastos com deslocamento/);
});
