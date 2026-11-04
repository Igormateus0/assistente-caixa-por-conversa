import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';

if (!process.env.DATABASE_ADMIN_URL) {
  console.error('DATABASE_ADMIN_URL não está carregada. Use npm.cmd run db:migrate, que lê .env.admin.');
  process.exit(1);
}
const pool = new Pool({ connectionString: process.env.DATABASE_ADMIN_URL, max: 1 });
try {
  const role = await pool.query('SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user');
  if (!role.rows[0]?.rolbypassrls) throw new Error('Use a conexão administrativa para aplicar o schema.');
  await pool.query(await readFile(new URL('../database/schema.sql', import.meta.url), 'utf8'));
  console.log('Schema aplicado; RLS e grants do papel do app atualizados.');
} catch (error) {
  console.error(`Falha ao aplicar o schema: ${error.code ?? 'erro PostgreSQL'}. Nenhuma credencial foi exibida.`);
  process.exitCode = 1;
} finally { await pool.end(); }