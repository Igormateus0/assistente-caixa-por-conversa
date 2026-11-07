import assert from 'node:assert/strict';
import test from 'node:test';
import { assertTestDatabaseIsolation } from '../scripts/database-target.mjs';

const supabase = (ref, username = 'postgres', port = '5432') =>
  'postgresql://' + username + ':hidden@db.' + ref + '.supabase.co:' + port + '/postgres';
const pooler = (ref, username = 'assistente_caixa_app') =>
  'postgresql://' + username + '.' + ref + ':hidden@aws-0-test.pooler.supabase.com:6543/postgres';

test('bloqueia teste quando app e teste apontam para o mesmo projeto Supabase', () => {
  assert.throws(() => assertTestDatabaseIsolation({
    appUrl: supabase('appref'),
    testUrl: pooler('appref'),
    testAdminUrl: supabase('appref'),
  }), /mesmo projeto\/banco do app/);
});

test('bloqueia outro nome de banco dentro do mesmo projeto Supabase', () => {
  assert.throws(() => assertTestDatabaseIsolation({
    appUrl: 'postgresql://postgres:hidden@db.appref.supabase.co:5432/postgres',
    testUrl: 'postgresql://postgres:hidden@db.appref.supabase.co:5432/test_db',
    testAdminUrl: 'postgresql://postgres:hidden@db.appref.supabase.co:5432/test_db',
  }), /mesmo projeto\/banco do app/);
});
test('aceita projeto de teste separado mesmo com admin direto e app via pooler', () => {
  assert.doesNotThrow(() => assertTestDatabaseIsolation({
    appUrl: supabase('appref'),
    testUrl: pooler('testref'),
    testAdminUrl: supabase('testref'),
  }));
});

test('bloqueia se o papel administrativo não aponta ao banco isolado de teste', () => {
  assert.throws(() => assertTestDatabaseIsolation({
    appUrl: supabase('appref'),
    testUrl: pooler('testref'),
    testAdminUrl: supabase('appref'),
  }), /mesmo projeto\/banco do app/);
});

test('compara banco local por host, porta e nome do banco', () => {
  const local = (user, port) => 'postgresql://' + user + ':hidden@127.0.0.1:' + port + '/assistente';
  assert.doesNotThrow(() => assertTestDatabaseIsolation({
    appUrl: local('app', '5432'),
    testUrl: local('test_app', '5433'),
    testAdminUrl: local('test_admin', '5433'),
  }));
  assert.throws(() => assertTestDatabaseIsolation({
    appUrl: local('app', '5432'),
    testUrl: local('test_app', '5432'),
    testAdminUrl: local('test_admin', '5432'),
  }), /mesmo projeto\/banco do app/);
});
