import { readFile } from 'node:fs/promises';

export async function readEnvFile(path) {
  const text = (await readFile(path, 'utf8')).replace(/^\uFEFF/, '');
  const values = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    values[match[1]] = value;
  }
  return values;
}

function identifyDatabase(connectionString) {
  let url;
  try { url = new URL(connectionString); }
  catch { throw new Error('Uma URL PostgreSQL de banco está ausente ou inválida.'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error('As URLs de banco precisam usar PostgreSQL.');
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  const directSupabase = url.hostname.match(/^db\.([^.]+)\.supabase\.co$/i);
  let projectRef = directSupabase?.[1]?.toLowerCase();
  if (!projectRef && url.hostname.toLowerCase().endsWith('.pooler.supabase.com')) {
    const username = decodeURIComponent(url.username);
    const separator = username.lastIndexOf('.');
    if (separator > 0) projectRef = username.slice(separator + 1).toLowerCase();
  }
  if (projectRef) return 'supabase:' + projectRef;
  return 'endpoint:' + url.hostname.toLowerCase() + ':' + (url.port || '5432') + ':' + database;
}

export function assertTestDatabaseIsolation({ appUrl, testUrl, testAdminUrl }) {
  const appTarget = identifyDatabase(appUrl);
  const testTarget = identifyDatabase(testUrl);
  const adminTarget = identifyDatabase(testAdminUrl);
  if (appTarget === testTarget || appTarget === adminTarget) {
    throw new Error('Banco de teste aponta para o mesmo projeto/banco do app; execução bloqueada.');
  }
  if (testTarget !== adminTarget) {
    throw new Error('DATABASE_TEST_URL e DATABASE_TEST_ADMIN_URL precisam apontar para o mesmo banco de teste.');
  }
}
