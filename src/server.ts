import Fastify from 'fastify';
import { Pool } from 'pg';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { handleAssistantMessage } from './assistant.js';
import { startTelegramPolling } from './telegram.js';

const app = Fastify({ logger: true });
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const rawBodies = new WeakMap<object, Buffer>();
let stopTelegram: () => Promise<void> = async () => {};
let shuttingDown = false;

app.addHook('onClose', async () => {
  await stopTelegram();
  await pool.end();
});

app.removeContentTypeParser('application/json');
app.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: 1024 * 1024 }, (request, body, done) => {
  const rawBody = Buffer.isBuffer(body) ? body : Buffer.from(body);
  rawBodies.set(request, rawBody);
  try {
    done(null, JSON.parse(rawBody.toString('utf8')));
  } catch (error) {
    done(error as Error);
  }
});

type IncomingMessage = {
  from: string;
  id: string;
  type: string;
  text?: { body: string };
};

type WebhookPayload = {
  entry?: Array<{ changes?: Array<{ value?: { messages?: IncomingMessage[] } }> }>;
};

app.get('/health', async () => ({ ok: true }));

app.get('/webhook', async (request, reply) => {
  const query = request.query as Record<string, string>;
  const expected = process.env.WHATSAPP_VERIFY_TOKEN;
  if (query['hub.mode'] === 'subscribe' && query['hub.verify_token'] === expected) {
    return reply.type('text/plain').send(query['hub.challenge']);
  }
  return reply.code(403).send('Verificação recusada');
});

app.post<{ Body: WebhookPayload }>('/webhook', async (request, reply) => {
  const appSecret = process.env.WHATSAPP_APP_SECRET;
  const signature = request.headers['x-hub-signature-256'];
  const rawBody = rawBodies.get(request);
  if (!appSecret) {
    app.log.error('WHATSAPP_APP_SECRET is missing');
    return reply.code(503).send({ error: 'Webhook não configurado' });
  }
  if (typeof signature !== 'string' || !isValidMetaSignature(rawBody, signature, appSecret)) {
    return reply.code(401).send({ error: 'Assinatura inválida' });
  }

  // Acknowledge quickly; message processing is deliberately kept small in this first slice.
  void processWebhook(request.body).catch((error) => app.log.error(error));
  return reply.code(200).send({ received: true });
});

function isValidMetaSignature(rawBody: Buffer | undefined, signature: string, appSecret: string) {
  if (!rawBody || !signature.startsWith('sha256=')) return false;
  const received = Buffer.from(signature.slice('sha256='.length), 'hex');
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  return received.length === expected.length && timingSafeEqual(received, expected);
}

async function processWebhook(payload: WebhookPayload) {
  const messages = payload.entry?.flatMap((entry) =>
    entry.changes?.flatMap((change) => change.value?.messages ?? []) ?? [],
  ) ?? [];

  for (const message of messages) {
    if (message.type !== 'text' || !message.text?.body) {
      await sendText(message.from, 'Por enquanto, consigo receber texto. O envio de áudio está chegando.');
      continue;
    }
    const reply = await handleAssistantMessage(pool, {
      userId: message.from,
      messageId: message.id,
      text: message.text.body,
    });
    if (reply) await sendText(message.from, reply);
  }
}

async function sendText(to: string, body: string) {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneId) {
    app.log.info({ to, body }, 'WhatsApp credentials missing; message logged instead');
    return;
  }
  const version = process.env.WHATSAPP_API_VERSION ?? 'v23.0';
  const response = await fetch(`https://graph.facebook.com/${version}/${phoneId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body } }),
  });
  if (!response.ok) throw new Error(`WhatsApp send failed: ${response.status} ${await response.text()}`);
}

const port = Number(process.env.PORT ?? 3000);
try {
  await app.listen({ port, host: '0.0.0.0' });
} catch (error) {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'EADDRINUSE') {
    app.log.error({ port, pid: process.pid }, `A porta ${port} já está em uso. Encerre a instância antiga antes de iniciar outra.`);
  } else {
    app.log.error(error, 'Não foi possível iniciar o servidor.');
  }
  await pool.end();
  process.exit(1);
}

const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
if (telegramToken) {
  stopTelegram = startTelegramPolling(pool, telegramToken, (error) => app.log.error(error));
  app.log.info('Telegram habilitado por long polling');
} else {
  app.log.info('Telegram desabilitado; configure TELEGRAM_BOT_TOKEN para ativar');
}

app.log.info({
  version: process.env.GIT_SHA || 'dev',
  pid: process.pid,
  startedAt: new Date().toISOString(),
  port,
}, 'Servidor iniciado');

async function shutdown(signal: 'SIGINT' | 'SIGTERM') {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal, pid: process.pid }, 'Encerrando servidor de forma segura');
  try {
    await app.close();
  } catch (error) {
    app.log.error(error, 'Erro durante o encerramento do servidor');
    process.exitCode = 1;
  }
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
