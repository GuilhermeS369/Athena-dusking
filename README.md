# Athena Scheduler

Plataforma multiempresa para organizar mídias, conectar perfis profissionais do Instagram, criar publicações e executar uma fila persistente de imagem, Reel, Story e carrossel.

## Arquitetura atual

- **Next.js 15 / App Router** para a aplicação web e rotas de API.
- **Supabase** para autenticação, Postgres com RLS e Storage privado.
- **Instagram Login for Business** pelo endpoint nativo do Instagram — sem Facebook Login.
- **Fila persistente** no Postgres com idempotência, leases, recuperação e retry com backoff.
- **Vercel Cron** chama o dispatcher de publicação uma vez por minuto.

O legado Express em [`server.js`](server.js) e [`api/index.js`](api/index.js) não é a entrada da aplicação hospedada. O projeto na Vercel deve usar o Framework Preset **Next.js**.

## Recursos disponíveis

- organizações e papéis `admin`, `operator` e `viewer`;
- conexão de perfis Instagram profissionais;
- grupos de perfis com política de mídia de uso único ou reutilizável;
- galeria privada de imagens e vídeos;
- postagem imediata ou agendada;
- publicação por perfil ou por grupo;
- agenda com filtro, detalhe, cancelamento e reprocessamento de falhas;
- painel de operação para conexões, erros e itens que exigem atenção;
- recuperação de senha por e-mail no login.

## Pré-requisitos

- Node.js 20 ou superior;
- projeto Supabase configurado;
- aplicativo Instagram Login for Business autorizado para a conta profissional que será conectada;
- projeto Vercel com suporte a Cron, caso a publicação automática em produção seja necessária.

## Variáveis de ambiente

Copie [`.env.example`](.env.example) para `.env.local` e preencha os valores reais.

| Variável | Uso |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | URL pública do projeto Supabase. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Chave anônima pública do Supabase. |
| `SUPABASE_SERVICE_ROLE_KEY` | Acesso privilegiado usado somente pelo worker server-side. Nunca usar com prefixo `NEXT_PUBLIC_`. |
| `INSTAGRAM_CLIENT_ID` | App ID do Instagram Login for Business. |
| `INSTAGRAM_CLIENT_SECRET` | Segredo do app Instagram. |
| `REDIRECT_URI` | Callback HTTPS registrado no painel do Instagram. |
| `META_OAUTH_STATE_SECRET` | Segredo longo e aleatório para assinar o state OAuth. |
| `TOKEN_ENCRYPTION_KEY` | Chave Base64 de 32 bytes para criptografar tokens persistidos. |
| `PUBLICATION_WORKER_SECRET` | Protege endpoints internos do worker. |
| `CRON_SECRET` | Segredo usado pela execução recorrente configurada na Vercel. |

Nunca envie, comite, exponha no navegador ou cole em tickets as chaves `SUPABASE_SERVICE_ROLE_KEY`, `INSTAGRAM_CLIENT_SECRET`, `TOKEN_ENCRYPTION_KEY`, `PUBLICATION_WORKER_SECRET` e `CRON_SECRET`.

## Desenvolvimento local

```bash
npm install
npm run dev
```

Abra `http://localhost:3000` e crie o primeiro usuário em **Supabase → Authentication → Users**. O login atual é por convite/acesso provisionado; a criação de organizações acontece no onboarding.

Para aplicar o esquema, vincule o CLI ao seu projeto Supabase e aplique as migrations da pasta [`supabase/migrations`](supabase/migrations):

```bash
npx supabase login
npx supabase link --project-ref SEU_PROJECT_REF
npx supabase db push
```

## Configuração do Instagram

1. No painel do Instagram for Developers, registre a URL de callback:
   `https://SEU-DOMINIO/api/integrations/meta/callback`.
2. Configure `REDIRECT_URI` com exatamente essa mesma URL.
3. Informe `INSTAGRAM_CLIENT_ID`, `INSTAGRAM_CLIENT_SECRET` e os segredos server-side no ambiente local e na Vercel.
4. Entre na Athena, abra **Perfis** e conecte uma conta profissional.
5. Envie mídia em **Galeria** e publique por **Postagem**.

Tokens do Instagram são criptografados antes de serem persistidos. A mídia permanece privada no Storage; o worker produz URLs assinadas temporárias de 24 horas para a API do Instagram processar cada publicação.

### Diagnóstico de perfis conectados

Ao terminar a autorização, a tela **Perfis** informa se uma conta foi criada, se um perfil já registrado foi reconectado ou a causa conhecida de uma falha no callback. O sistema nunca mostra tokens, códigos OAuth ou segredos na interface.

Para checagem operacional no SQL Editor do Supabase, use apenas campos públicos:

```sql
select
  id,
  organization_id,
  instagram_user_id,
  username,
  display_name,
  status,
  deleted_at,
  created_at,
  updated_at,
  token_expires_at
from public.instagram_profiles
order by updated_at desc;
```

Não selecione nem compartilhe `encrypted_access_token`. Um registro com `deleted_at` preenchido foi removido logicamente e não aparece no sistema. Para uma conta nova, deve existir uma linha com `deleted_at` nulo; para uma reconexão da mesma conta e organização, essa mesma linha é atualizada e recebe um token renovado. A restrição de unicidade permite diversos perfis, desde que cada `instagram_user_id` seja distinto dentro da organização.

## Fila e cron

A fila de publicação é processada **exclusivamente pelos workers da VPS** (PM2, `/opt/athena-worker`), pelo caminho direto e pelo spool em disco. Desde 07/09/2026 **não existe despachante na Vercel**: a rota `/api/internal/publication-dispatch` foi removida (decisão do dono), e se a VPS cair a resposta é subir outro processo lá. Os crons que restam em [`vercel.json`](vercel.json) são de manutenção (exclusão de mídia, analytics, resumo da dashboard, análise de recuperação).

**Antes de mexer em qualquer coisa da fila, leia [docs/fila-de-publicacao-MASTER.md](docs/fila-de-publicacao-MASTER.md)**: peças, ciclo de vida, regras, tetos, erros, procedimentos e onde olhar por sintoma.

### Regras de agendamento

- **Data única:** a data, hora e minuto escolhidos são preservados sem aleatorização. O mesmo perfil não pode ter outra publicação ativa naquele mesmo minuto, independentemente de ser Imagem, Reel, Story, Carrossel ou de pertencer a outro lote. A interface sinaliza o conflito e impede o envio; o banco também o bloqueia para proteger contra ações simultâneas.
- **Horário recorrente ou sem data:** o horário escolhido é o início de uma janela, não o instante final. Para `12:00`, o sistema sorteia um minuto livre entre `12:01` e `12:09`, e depois sorteia os segundos entre `00` e `59` daquele minuto. O minuto-base `12:00` nunca é usado por esse fluxo.
- **Uma postagem por minuto por perfil:** depois que um formato ocupa, por exemplo, `12:04:37`, nenhum formato do mesmo perfil pode usar qualquer horário entre `12:04:00` e `12:04:59`. Outros perfis continuam independentes.
- **Janela esgotada:** quando os nove minutos posteriores estiverem ocupados, a reserva continua na próxima janela de dez minutos do mesmo dia (`12:11`–`12:19`, depois `12:21`–`12:29` etc.) até encontrar vaga.
- **Programação em massa, esquema Sequencial:** cada perfil recebe a quantidade escolhida de postagens, uma após a outra no intervalo informado (a partir de 1 minuto), sem o intervalo mínimo entre postagens do mesmo perfil. Com a caixa "Escolher horário inicial" marcada, o primeiro perfil posta no horário escolhido (São Paulo) e os demais entram espalhados nos 10 minutos seguintes; sem ela, a sequência começa depois do que o perfil já tem agendado. Continua valendo o limite de 100 publicações por perfil em 24 horas. Detalhes na seção 3 do documento mestre da fila.
- O cron é executado uma vez por minuto, portanto o processamento pode começar após o instante reservado devido à infraestrutura ou à resposta da API do Instagram. Isso não altera o horário aleatório salvo na fila.

### Normalização de agendamentos legados

A migration [`supabase/migrations/026_randomize_legacy_waiting_publications.sql`](supabase/migrations/026_randomize_legacy_waiting_publications.sql) cria funções operacionais, mas não altera horários automaticamente. Ela trata exclusivamente itens futuros no estado `waiting`; itens em processamento, publicados, falhos, cancelados ou imediatos são preservados.

1. Consulte `select * from public.preview_legacy_waiting_randomization();` para inspecionar os itens elegíveis.
2. Execute `select * from public.randomize_legacy_waiting_publications();` e guarde o `run_id` retornado.
3. Caso necessário, use `select * from public.rollback_legacy_waiting_randomization('<run_id>');`. O rollback é conservador e não altera itens que já saíram de `waiting`, cujo horário original já passou ou cujo minuto original está ocupado.

Cada alteração registra o horário original e o novo na tabela `publication_schedule_randomizations`.

## Verificação antes de operar

1. Conecte uma conta Instagram profissional de teste.
2. Publique uma imagem imediata e confirme o status `Publicado` na Agenda.
3. Publique um Reel imediato.
4. Crie uma publicação agendada e confirme sua execução.
5. Teste Story e carrossel na conta autorizada, pois validações finais de formato dependem da API do Instagram.
6. Em caso de falha, use **Agenda** para ler o erro e reprocessar quando a causa tiver sido corrigida.

## Build de produção

```bash
npm run build
```

Não configure `NODE_ENV` manualmente nas variáveis da Vercel. A plataforma define o ambiente durante o build; sobrescrevê-lo pode impedir a instalação das devDependencies necessárias ao TypeScript.
