import type { Pool } from 'pg';
import { handleAssistantMessage } from './assistant.js';

const API_BASE = 'https://api.telegram.org/bot';
const POLL_TIMEOUT_SECONDS = 30;

type TelegramUpdate = {
  update_id: number;
  message?: {
    message_id: number;
    from?: { id: number; is_bot?: boolean };
    chat: { id: number; type: string };
    text?: string;
  };
};

type TelegramEnvelope<T> = {
  ok: boolean;
  result?: T;
  description?: string;
};

/** Inicia o adaptador de entrada do Telegram usando long polling, sem URL pública. */
export function startTelegramPolling(
  pool: Pool,
  token: string,
  onError: (error: Error) => void,
) {
  const controller = new AbortController();
  let offset: number | undefined;

  const polling = (async () => {
    while (!controller.signal.aborted) {
      try {
        const updates = await telegramRequest<TelegramUpdate[]>(token, 'getUpdates', {
          ...(offset === undefined ? {} : { offset }),
          timeout: POLL_TIMEOUT_SECONDS,
          allowed_updates: ['message'],
        }, controller.signal);

        for (const update of updates) {
          // Confirma o update só depois de processá-lo para evitar perda em falha transitória.
          await processUpdate(pool, token, update);
          offset = update.update_id + 1;
        }
      } catch (error) {
        if (controller.signal.aborted) break;
        const normalizedError = error instanceof Error ? error : new Error('Falha desconhecida no Telegram');
        if (normalizedError.message.includes('409')) {
          onError(new Error('Telegram retornou HTTP 409: outra instância está consultando getUpdates com este token. Pare a outra instância e mantenha apenas um servidor ativo.'));
        } else {
          onError(normalizedError);
        }
        await wait(2000, controller.signal);
      }
    }
  })();

  return async () => {
    controller.abort();
    await polling;
  };
}

async function processUpdate(pool: Pool, token: string, update: TelegramUpdate) {
  const message = update.message;
  if (!message || message.from?.is_bot) return;

  if (message.chat.type !== 'private' || !message.from) {
    if (message.chat.type !== 'private') {
      await sendText(token, message.chat.id, 'Por privacidade, use este assistente em uma conversa privada comigo.');
    }
    return;
  }

  const response = message.text?.trim()
    ? await handleAssistantMessage(pool, {
      userId: `telegram:${message.from.id}`,
      messageId: `telegram:${message.chat.id}:${message.message_id}`,
      text: message.text,
    })
    : 'Por enquanto, consigo receber mensagens de texto. O suporte a áudio será uma etapa futura.';

  await sendText(token, message.chat.id, response);
}

async function sendText(token: string, chatId: number, text: string) {
  // Telegram limita sendMessage a 4096 caracteres; quebramos apenas entre linhas quando possível.
  const chunks = splitMessage(text, 4000);
  for (const chunk of chunks) {
    await telegramRequest(token, 'sendMessage', { chat_id: chatId, text: chunk });
  }
}

function splitMessage(text: string, maxLength: number) {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLength) {
    let splitAt = remaining.lastIndexOf('\n', maxLength);
    if (splitAt < Math.floor(maxLength * 0.5)) splitAt = maxLength;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

async function telegramRequest<T = unknown>(
  token: string,
  method: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`${API_BASE}${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: signal ?? AbortSignal.timeout(35_000),
  });
  const result = await response.json() as TelegramEnvelope<T>;
  if (!response.ok || !result.ok) {
    // Não incluir URL ou token na mensagem de erro/log.
    throw new Error(`Telegram ${method} falhou (${response.status}): ${result.description ?? 'erro sem descrição'}`);
  }
  return result.result as T;
}

function wait(ms: number, signal: AbortSignal) {
  if (signal.aborted || ms === 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
