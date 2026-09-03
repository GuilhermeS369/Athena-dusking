-- Volta o teto por minuto da Zernio de 1200 para 600.
--
-- INCIDENTE DE 02/09/2026, ~21h BRT: o painel inteiro parou em "carregando" e o
-- Supabase acusou 99,1% de erro no banco (70.507 no intervalo das 21h). A causa
-- nao foi o Postgres: `blocking` e `long-running-queries` vazios, index e table
-- hit rate em 1.00. Foi o pool de conexoes do PostgREST, que parou de entregar
-- conexao: um `select id from organizations limit 1` devolveu
-- PGRST003 "Timed out acquiring connection from connection pool" e, na segunda
-- tentativa, nao respondeu em 3 minutos. A role `authenticator` estava com 41
-- conexoes ativas e o snapshot de atividade ao vivo era quase todo chamada a
-- `complete_publication_preparation` -- o worker de publicacao.
--
-- O gatilho foi a soma de duas coisas no mesmo dia: este teto subir para 1200 as
-- 10:47 (migration 355) e uma onda de agendamento em massa a noite.
--
-- O QUE ESTA REVERSAO FAZ, E O QUE ELA NAO FAZ. A migration 355 esta certa ao
-- dizer que este numero nao controla paralelismo: ele nao abre conexao, e voltar
-- para 600 nao fecha nenhuma. O que ele controla e ADIAMENTO -- com 600, as
-- reservas em voo (300s) encostam no teto e o pipeline para ate elas vencerem, e
-- durante essas pausas o worker nao bate no PostgREST. E isso que derruba a taxa
-- sustentada de requisicao contra o pool. O pico de conexoes simultaneas continua
-- sendo PUBLICATION_WORKER_STAGED_DISPATCH_CONCURRENCY, que segue em 64 na VPS:
-- se o pool nao se recuperar, e la que se mexe, nao aqui.
--
-- O custo aceito e o que a 355 media: uma onda de 733 itens volta a escoar em
-- ~11 minutos em vez de ~3. Publicacao atrasada, nao perdida.
--
-- COMO REVERTER ESTA REVERSAO: o mesmo UPDATE devolvendo 1200. Efeito imediato
-- na proxima chamada da funcao, sem deploy.
update public.publication_rate_limit_settings
set max_provider_publications_per_minute = 600,
    metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
      'minute_limit_note',
      'Volta de 1200 para 600 em 02/09/2026, ~21h BRT, durante o incidente de '
      || 'esgotamento do pool de conexoes do PostgREST (PGRST003 em consulta '
      || 'trivial, 41 conexoes na role authenticator, 99,1% de erro no painel '
      || 'do Supabase). O teto nao controla conexao simultanea -- isso e '
      || 'STAGED_DISPATCH_CONCURRENCY, que segue em 64 -- mas controla '
      || 'adiamento, e o adiamento e o que derruba a taxa sustentada de '
      || 'requisicao. Ver docs/fila-de-publicacao-mapa-de-controles.md.'
    ),
    updated_at = timezone('utc', now())
where organization_id is null
  and provider = 'zernio';
