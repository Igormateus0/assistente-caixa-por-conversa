# Caixa por Conversa

Primeiro recorte do MVP: processar mensagens de texto pelo simulador local, Telegram ou webhook do WhatsApp, pedir confirmação e só então gravar no PostgreSQL.

## O que já está preparado

- Webhook de verificação e recebimento para WhatsApp Cloud API.
- Adaptador experimental do Telegram por long polling, ativado somente quando `TELEGRAM_BOT_TOKEN` estiver configurado.
- Rascunho pendente separado dos lançamentos confirmados.
- Confirmação explícita antes de gravar.
- Comandos `sim`, `cancelar` e `corrigir`.
- Consulta de entradas, saídas e saldo do mês.
- Valores armazenados em centavos e proteção contra mensagem duplicada.
- Simulador de terminal para experimentar a conversa localmente com perfis de teste separados.

Áudio, exportação e duração do serviço ainda não estão implementados. A interpretação atual é intencionalmente simples e baseada em texto; antes de aceitar uso real, será necessário melhorar a extração e validar a integração ponta a ponta.

## Preparação local

1. Instale Node.js 22 ou superior.
2. Preencha `DATABASE_URL` no `.env` local com a conexão PostgreSQL. Para usar WhatsApp, preencha também as variáveis `WHATSAPP_*`. O `.env` é ignorado pelo Git e nunca deve ser enviado ao repositório.
3. Aplique/atualize `database/schema.sql` no banco PostgreSQL/Supabase. O arquivo inclui migrações aditivas para auditoria e reversões; faça backup antes de executar em uma base com dados importantes.
4. Instale as dependências com `npm.cmd install`; rode `npm.cmd test` para testar e compilar.

## Simulador local

O simulador usa a mesma lógica de conversa do webhook e o banco definido em `DATABASE_URL`. Ele não chama WhatsApp nem envia mensagens para fora. Inicie com `npm.cmd run simulate` depois de compilar. Digite mensagens como `recebi 150 por um corte`, responda `sim` para confirmar, ou use `listar`, `corrigir ID`, `desfazer` e `resumo hoje|semana|mês`. Uma correção pode ser preparada com `corrigir ID valor 130` ou em etapas: `corrigir ID`, `descrição novo detalhe`, `categoria Transporte`, `valor 130`, `sim`. Correções e reversões exigem confirmação. Use `/usuario manicure` para trocar o perfil de teste e `/sair` para encerrar. Os lançamentos de teste são persistidos no banco no perfil `local:<nome>`.

Para testar o Telegram, crie um bot pelo [@BotFather](https://t.me/BotFather), coloque o token em `TELEGRAM_BOT_TOKEN` no `.env` local, reinicie o servidor com `npm.cmd run dev` e abra uma conversa privada com o bot. O servidor usa long polling e não precisa de URL pública. Não compartilhe nem envie o token ao Git.

O Telegram e o WhatsApp usam identificadores de usuário separados (`telegram:` e o número do WhatsApp), mantendo os perfis e lançamentos isolados. Este adaptador inicial aceita texto em conversa privada; áudio e grupos não são suportados. Para testar o webhook da Meta, configure uma URL pública HTTPS `/webhook` e inscreva o app no campo `messages`. O endpoint valida a assinatura `X-Hub-Signature-256` com `WHATSAPP_APP_SECRET` antes de aceitar notificações.

Sem credenciais de envio, as respostas ficam no log do servidor para permitir desenvolvimento local. Não coloque segredos no Git.

## Exemplos de conversa

- `Recebi 150 por um corte` → o bot pede confirmação; `sim` grava.
- `Gastei 20 com gasolina` → o bot pede confirmação; `sim` grava.
- `resumo hoje`, `resumo semana`, `resumo mês` ou `resumo 01/10/2026 até 31/10/2026` → mostra totais, saldo registrado, contagem, maior categoria de saída e detalhes com descrição.
- `cancelar` → descarta o rascunho pendente.
- `listar` → mostra os IDs dos últimos lançamentos ativos para consulta e correção.
- `detalhe ID` → consulta os dados e a data de um lançamento pelo ID.
- `corrigir ID` → inicia correção de um lançamento salvo; os campos suportados são valor, categoria, tipo e descrição. A alteração só é aplicada depois de `sim`.
- `desfazer` → mostra a operação mais recente e pede confirmação. Ao confirmar, ela é marcada como revertida e permanece no histórico de auditoria.

O saldo é calculado com base nos lançamentos enviados pelo usuário. Não representa conciliação bancária nem conhecimento de movimentações que não foram registradas.
