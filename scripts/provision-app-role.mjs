import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile, access } from 'node:fs/promises';
import { Pool } from 'pg';
import { readEnvFile, assertTestDatabaseIsolation } from './database-target.mjs';

const testMode = process.argv.includes('--test');
const envPath = new URL(testMode ? '../.env.test' : '../.env', import.meta.url);
const adminEnvPath = new URL('../.env.admin', import.meta.url);
const appEnv = testMode ? await readEnvFile(new URL('../.env', import.meta.url)) : undefined;
const targetEnv = testMode ? await readEnvFile(envPath) : process.env;
const adminUrlText = testMode ? targetEnv.DATABASE_TEST_ADMIN_URL : process.env.DATABASE_URL;
if (!adminUrlText) {
  throw new Error(testMode
    ? 'Configure DATABASE_TEST_ADMIN_URL em .env.test para o banco de teste separado.'
    : 'Preencha DATABASE_URL com a conexão administrativa temporária antes do provisionamento.');
}
if (testMode) {
  if (!appEnv?.DATABASE_URL) throw new Error('DATABASE_URL do app não foi encontrada em .env; não consigo provar o isolamento.');
  if (targetEnv.DATABASE_TEST_URL) throw new Error('DATABASE_TEST_URL já existe; não vou sobrescrever o papel existente.');
  assertTestDatabaseIsolation({ appUrl: appEnv.DATABASE_URL, testUrl: adminUrlText, testAdminUrl: adminUrlText });
} else {
  try { await access(adminEnvPath); throw new Error('.env.admin já existe; interrompi para não sobrescrever credenciais.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

const adminUrl = new URL(adminUrlText);
const roleName = 'assistente_caixa_app';
const sharedPooler = adminUrl.hostname.endsWith('.pooler.supabase.com');
const adminUsername = decodeURIComponent(adminUrl.username);
const projectRef = sharedPooler ? adminUsername.split('.').at(-1) : '';
if (sharedPooler && (!projectRef || !adminUsername.includes('.'))) {
  throw new Error('A conexão do pooler não contém o identificador de projeto esperado. Copie a URL completa do Supabase.');
}
const appPassword = randomBytes(48).toString('hex');
const appUrl = new URL(adminUrlText);
appUrl.username = sharedPooler ? `${roleName}.${projectRef}` : roleName;
appUrl.password = appPassword;

const adminPool = new Pool({ connectionString: adminUrlText, max: 1 });
let appPool;
let smokeKey;
try {
  const currentRole = await adminPool.query(`
    SELECT r.rolsuper, r.rolbypassrls
    FROM pg_roles r WHERE r.rolname = current_user
  `);
  if (!currentRole.rows[0]?.rolbypassrls) {
    throw new Error('A conexão atual não é administrativa. Use a conexão PostgreSQL de administração apenas nesta etapa.');
  }

  const schema = await readFile(new URL('../database/schema.sql', import.meta.url), 'utf8');
  await adminPool.query(schema);
  const databaseName = (await adminPool.query('SELECT current_database() AS name')).rows[0].name;
  const quotedDatabase = `"${databaseName.replaceAll('"', '""')}"`;
  await adminPool.query(`GRANT CONNECT ON DATABASE ${quotedDatabase} TO ${roleName}`);
  const appRoleAttrs = await adminPool.query(`
    SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication
    FROM pg_roles WHERE rolname = $1
  `, [roleName]);
  if (!appRoleAttrs.rows[0] || Object.values(appRoleAttrs.rows[0]).some(Boolean)) {
    throw new Error('O papel de aplicação já existe com atributos elevados; não alterei a senha nem o .env.');
  }
  const passwordStatement = await adminPool.query(
    `SELECT format('ALTER ROLE ${roleName} WITH LOGIN PASSWORD %L', $1::text) AS sql`,
    [appPassword],
  );
  await adminPool.query(passwordStatement.rows[0].sql);

  appPool = new Pool({ connectionString: appUrl.toString(), max: 1 });
  const appRole = await appPool.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
  if (appRole.rows[0]?.rolsuper || appRole.rows[0]?.rolbypassrls) {
    throw new Error('O papel recém-criado não está com os privilégios esperados.');
  }
  smokeKey = `provision-check:${randomUUID()}`;
  const client = await appPool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.user_key', smokeKey]);
    await client.query('INSERT INTO users (whatsapp_id) VALUES ($1)', [smokeKey]);
    const visible = await client.query('SELECT id FROM users WHERE whatsapp_id = $1', [smokeKey]);
    if (visible.rowCount !== 1) throw new Error('O papel restrito não conseguiu ler o próprio perfil.');
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }

  const deniedWithoutContext = await appPool.query('SELECT id FROM users WHERE whatsapp_id = $1', [smokeKey]);
  if (deniedWithoutContext.rowCount !== 0) throw new Error('RLS não negou acesso sem contexto de usuário.');

  const envText = await readFile(envPath, 'utf8');
  if (testMode) {
    const appLine = 'DATABASE_TEST_URL="' + appUrl.toString() + '"';
    const updatedEnv = /^\s*DATABASE_TEST_URL=.*$/m.test(envText)
      ? envText.replace(/^\s*DATABASE_TEST_URL=.*$/m, appLine)
      : envText.trimEnd() + '\n' + appLine + '\n';
    await writeFile(envPath, updatedEnv, 'utf8');
    console.log('Papel restrito de teste criado; .env.test recebeu DATABASE_TEST_URL. Nenhuma senha foi exibida.');
  } else {
    const adminEnvText = 'DATABASE_ADMIN_URL="' + adminUrlText + '"\n';
    const appLine = 'DATABASE_URL="' + appUrl.toString() + '"';
    const updatedEnv = envText.replace(/^\s*DATABASE_URL=.*$/m, appLine);
    if (updatedEnv === envText && !/^\s*DATABASE_URL=/m.test(envText)) {
      throw new Error('Não encontrei DATABASE_URL no .env; não gravei as credenciais novas.');
    }
    await writeFile(adminEnvPath, adminEnvText, { encoding: 'utf8', flag: 'wx' });
    await writeFile(envPath, updatedEnv, 'utf8');
    console.log('Papel PostgreSQL restrito criado; .env usa a conexão do app e .env.admin guarda a conexão administrativa local.');
  }
  console.log('Teste de conexão, leitura do próprio perfil e bloqueio sem contexto passaram. Nenhuma senha foi exibida.');
} catch (error) {
  console.error('Provisionamento interrompido (' + (error.code ?? 'configuração') + '). Nenhuma credencial foi exibida.');
  process.exitCode = 1;
} finally {
  if (appPool) await appPool.end();
  if (smokeKey) {
    await adminPool.query('DELETE FROM users WHERE whatsapp_id = $1', [smokeKey]).catch(() => {});
  }
  await adminPool.end();
}