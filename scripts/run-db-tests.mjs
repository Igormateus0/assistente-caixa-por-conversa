import { spawn } from 'node:child_process';
import { readEnvFile, assertTestDatabaseIsolation } from './database-target.mjs';

let appEnv;
let testEnv;
try {
  appEnv = await readEnvFile('.env');
  testEnv = await readEnvFile('.env.test');
  assertTestDatabaseIsolation({
    appUrl: appEnv.DATABASE_URL,
    testUrl: testEnv.DATABASE_TEST_URL,
    testAdminUrl: testEnv.DATABASE_TEST_ADMIN_URL,
  });
} catch (error) {
  console.error('Teste integrado bloqueado: ' + error.message);
  process.exit(1);
}

const childEnv = { ...process.env };
for (const key of Object.keys(childEnv)) {
  if (key.startsWith('DATABASE_') || key.startsWith('WHATSAPP_') || key.startsWith('PG') || key === 'TELEGRAM_BOT_TOKEN') delete childEnv[key];
}
childEnv.DATABASE_TEST_URL = testEnv.DATABASE_TEST_URL;
childEnv.DATABASE_TEST_ADMIN_URL = testEnv.DATABASE_TEST_ADMIN_URL;

const child = spawn(process.execPath, ['--test', 'test/assistant.integration.test.mjs'], {
  stdio: 'inherit',
  env: childEnv,
});
child.on('error', (error) => {
  console.error('Não foi possível iniciar os testes integrados (' + (error.code || 'erro de processo') + ').');
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  if (signal) process.exitCode = 1;
  else process.exitCode = code ?? 1;
});
