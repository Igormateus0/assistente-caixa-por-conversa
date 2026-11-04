import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { Pool } from 'pg';
import { handleAssistantMessage } from './assistant.js';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL não está configurada. Confira seu .env local.');
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const terminal = createInterface({ input: stdin, output: stdout });
let activeUser = 'igor';
let messageNumber = 0;

console.log('Simulador local do Assistente de Caixa');
console.log('As mensagens usam o banco configurado em DATABASE_URL e ficam separadas por usuário de teste.');
console.log('Comandos: /usuario NOME troca o perfil de teste; /sair encerra.');
console.log('Exemplos: “recebi 150 por um corte”, “gastei 20 com gasolina”, “quanto sobrou?”');

try {
  while (true) {
    const input = (await terminal.question(`\nVocê [${activeUser}]: `)).trim();
    if (!input) continue;
    if (input.toLocaleLowerCase('pt-BR') === '/sair') break;

    const userCommand = input.match(/^\/usuario\s+(.+)$/i);
    if (userCommand) {
      const safeName = normalizeUserName(userCommand[1]);
      if (!safeName) {
        console.log('Escolha um nome simples, por exemplo: /usuario manicure');
        continue;
      }
      activeUser = safeName;
      console.log(`Agora você está testando como “${activeUser}”.`);
      continue;
    }

    try {
      const response = await handleAssistantMessage(pool, {
        userId: `local:${activeUser}`,
        messageId: `local:${activeUser}:${Date.now()}:${++messageNumber}`,
        text: input,
      });
      console.log(`Assistente: ${response}`);
    } catch (error) {
      console.error('Não consegui processar essa mensagem. Confira a conexão com o banco e tente novamente.');
      console.error(error instanceof Error ? error.message : 'Erro desconhecido');
    }
  }
} finally {
  terminal.close();
  await pool.end();
}

function normalizeUserName(name: string) {
  return name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR')
    .replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}
