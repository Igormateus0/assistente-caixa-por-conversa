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

1. Instale Node.js 22 ou superior e as dependências com `npm.cmd install`.
2. No primeiro provisionamento, coloque temporariamente a conexão administrativa do PostgreSQL/Supabase em `DATABASE_URL` no `.env` local. Faça backup antes de alterar um banco com dados importantes e rode `npm.cmd run db:secure`. O script aplica `database/schema.sql`, cria `assistente_caixa_app` com senha aleatória, testa o acesso restrito e troca `DATABASE_URL` para a conexão do app. A conexão administrativa é movida para `.env.admin`, que fica ignorado pelo Git.
3. O servidor carrega apenas `.env`; não configure `DATABASE_ADMIN_URL` no ambiente publicado. Use `npm.cmd run db:migrate` para aplicar futuras alterações do schema com a conexão local administrativa.
4. Rode `npm.cmd test`. O teste integrado requer o banco separado descrito abaixo; não execute `npm.cmd run test:db` até configurar `.env.test`. Para commits, instale o hook local do Gitleaks com `powershell -ExecutionPolicy Bypass -File scripts/install-gitleaks-hook.ps1`.
5. Para usar WhatsApp, preencha somente as variáveis `WHATSAPP_*` necessárias no `.env`. Não envie `.env` nem `.env.admin` ao Git.
## Simulador local

O simulador usa a mesma lógica de conversa do webhook e o banco definido em `DATABASE_URL`. Ele não chama WhatsApp nem envia mensagens para fora. Inicie com `npm.cmd run simulate` depois de compilar. Digite mensagens como `recebi 150 por um corte`, responda `sim` para confirmar, ou use `listar`, `corrigir ID`, `desfazer` e `resumo hoje|semana|mês`. Uma correção pode ser preparada com `corrigir ID valor 130` ou em etapas: `corrigir ID`, `descrição novo detalhe`, `categoria Transporte`, `valor 130`, `sim`. Correções e reversões exigem confirmação. Use `/usuario manicure` para trocar o perfil de teste e `/sair` para encerrar. Os lançamentos de teste são persistidos no banco no perfil `local:<nome>`.

Para testar o Telegram, crie um bot pelo [@BotFather](https://t.me/BotFather), coloque o token em `TELEGRAM_BOT_TOKEN` no `.env` local, reinicie o servidor com `npm.cmd run dev` e abra uma conversa privada com o bot. O servidor usa long polling e não precisa de URL pública. Não compartilhe nem envie o token ao Git.

O Telegram e o WhatsApp usam identificadores de usuário separados (`telegram:` e o número do WhatsApp), mantendo os perfis e lançamentos isolados. Este adaptador inicial aceita texto em conversa privada; áudio e grupos não são suportados. Para testar o webhook da Meta, configure uma URL pública HTTPS `/webhook` e inscreva o app no campo `messages`. O endpoint valida a assinatura `X-Hub-Signature-256` com `WHATSAPP_APP_SECRET` antes de aceitar notificações.

Sem credenciais de envio, as respostas ficam no log do servidor para permitir desenvolvimento local. Não coloque segredos no Git.

## Demonstração

No simulador ou em uma conversa privada com o bot no Telegram, use um perfil de teste e envie:

1. **Recebi 150 pelo corte da Ana** → confira o valor e a descrição e responda **sim**.
2. **Gastei 20 com gasolina** → confira a despesa e responda **sim**.
3. **Resumo mês** → em um perfil sem outros lançamentos, o saldo registrado será de R$ 130,00.
4. **Listar** → escolha o ID da despesa, envie **desfazer ID** e confirme com **sim**. O saldo volta a R$ 150,00 e a reversão fica no histórico.

O simulador e o Telegram usam a mesma lógica de registro e confirmação. O PostgreSQL isola os perfis com RLS e mantém a auditoria de criação, correção e reversão. Este MVP demonstra o fluxo por texto. Áudio e exportação estão no roadmap.

## Exemplos de conversa

- `Recebi 150 por um corte` → o bot pede confirmação; `sim` grava.
- `Gastei 20 com gasolina` → o bot pede confirmação; `sim` grava.
- `resumo hoje`, `resumo semana`, `resumo mês` ou `resumo 01/10/2026 até 31/10/2026` → mostra totais, saldo registrado, contagem, maior categoria de saída e detalhes com descrição.
- `cancelar` → descarta o rascunho pendente.
- `listar` → mostra os IDs dos últimos lançamentos ativos para consulta e correção.
- `detalhe ID` → consulta os dados e a data de um lançamento pelo ID.
- `corrigir ID` → inicia correção de um lançamento salvo; os campos suportados são valor, categoria, tipo e descrição. A alteração só é aplicada depois de `sim`.
- `desfazer` → lista lançamentos ativos; use `desfazer ID` para escolher um e confirme antes da reversão. O registro fica preservado no histórico de auditoria.

O saldo é calculado com base nos lançamentos enviados pelo usuário. Não representa conciliação bancária nem conhecimento de movimentações que não foram registradas.

## Banco isolado para teste integrado

O teste integrado nunca deve usar o banco do bot nem a conexão administrativa dele.

1. Crie ou escolha um PostgreSQL de teste separado. Pode ser um segundo projeto Supabase ou um PostgreSQL local. No Supabase Free há limite de projetos ativos e projetos sem atividade suficiente podem ser pausados; confira a [página de preços](https://supabase.com/pricing) e a [regra de pausa](https://supabase.com/docs/guides/platform/free-project-pausing).
2. Copie o arquivo .env.test.example para .env.test e coloque em DATABASE_TEST_ADMIN_URL somente a conexão administrativa do banco de teste. Não copie .env.admin.
3. Rode npm.cmd run db:secure:test. O provisionador compara o alvo com DATABASE_URL de .env e interrompe se for o mesmo projeto/banco. Se passar, ele aplica o schema no banco de teste e grava a conexão restrita em DATABASE_TEST_URL, sem imprimir senhas.
4. Rode npm.cmd run test:db. O script valida que as duas URLs de teste apontam ao mesmo banco e que ele é diferente do banco do app. O processo de teste recebe apenas as credenciais do banco de teste; a conexão administrativa do app não é carregada.

O teste integrado é dividido em casos nomeados para RLS, resumo/correção, reversão de ID alheio, reversão repetida, correção de ID alheio, user_id trocado e auditoria. A limpeza usa privilégio administrativo exclusivamente no banco de teste.

A página de preços oficial do Supabase explica o limite do plano gratuito. A documentação oficial explica quando projetos gratuitos podem ser pausados por inatividade.
