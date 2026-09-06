-- Retry de infraestrutura ganha contador e recuo exponencial.
--
-- O QUE ACONTECEU EM 06/09/2026. Dois itens ficaram 73 e 78 minutos repetindo
-- `57014` a cada 30 segundos, e entre os dois estrangularam a perna de
-- confirmacao do pipeline inteiro. A conta:
--
--   1. `defer_publication_infrastructure_failure` adia 30 s FIXOS e nao conta
--      nada. Nao ha teto, nao ha recuo: o item volta a cada ciclo, para sempre.
--   2. `claim_publication_items` nao gasta tentativa de item que ja tem
--      `creation_id` (e certo: polling nao e nova tentativa de publicar), entao
--      `PUBLICATION_MAX_ATTEMPTS` nunca chega. Os dois itens marcaram
--      `attempt_count = 1` durante os 78 minutos.
--   3. Item com `creation_id` entra na banda de prioridade 0 do claim. Ou seja:
--      os dois envenenados eram reivindicados PRIMEIRO, em todo ciclo.
--   4. Com lote de 3, dois itens com erro dao 66% de pressao, e o controlador
--      adaptativo cortava pela metade -- serrote 1, 2, 3, 1, 2, 3 sem fim.
--   5. O caminho direto e o UNICO que faz polling (o spool so aceita item com
--      `execute_at` no futuro). Resultado medido: 98 itens elegiveis parados,
--      mediana de 18 minutos de espera por UMA consulta de status.
--
-- Efeito no usuario: 35% das publicacoes passando de 5 minutos de atraso e
-- p90 de 9,8 minutos entre criar o conteiner e confirmar -- sendo que 98,3%
-- dos itens ficam prontos LOGO na primeira consulta. O tempo nao era da Meta.
--
-- A CORRECAO, e o que ela deliberadamente NAO faz. O principio da 272 fica de
-- pe: indisponibilidade de banco NUNCA vira falha terminal, porque o item nao
-- tem culpa e perder publicacao e pior do que atrasa-la. Entao nao se
-- introduz teto que mate o item. O que se introduz e RECUO: o item continua
-- vivo e continua tentando, mas para de voltar a cada 30 segundos.
--
--   tentativa 1 ->  30 s     tentativa 4 -> 240 s
--   tentativa 2 ->  60 s     tentativa 5 -> 480 s
--   tentativa 3 -> 120 s     tentativa 6+ -> 900 s (teto)
--
-- Com isso um item que continua falhando sai do caminho quente sozinho, em vez
-- de ocupar vaga do lote e derrubar o controlador. O jitter existe para que uma
-- leva inteira que falhou junto nao volte junto.
--
-- O contador zera quando o item avanca de verdade -- em `defer_publication_item`
-- (conteiner criado ou consulta bem-sucedida) e em `complete_publication_item`.
-- Sem isso, uma falha de infraestrutura de ontem penalizaria a publicacao de
-- hoje.

alter table public.publication_items
  add column if not exists infrastructure_retry_count integer not null default 0;

comment on column public.publication_items.infrastructure_retry_count is
  'Adiamentos consecutivos por falha de infraestrutura (57014, pool, fetch). Zera ao avancar. Alimenta o recuo exponencial da 420.';

create or replace function public.defer_publication_infrastructure_failure(
  p_item_id uuid,
  p_worker_id text,
  p_error_code text,
  p_error_message text,
  p_delay_seconds integer default 30
)
returns table (id uuid, status public.publication_item_status, creation_id text, next_attempt_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  item_row public.publication_items%rowtype;
  updated_row public.publication_items%rowtype;
  next_count integer;
  effective_delay integer;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Acao permitida somente ao worker.';
  end if;
  if p_delay_seconds not between 15 and 900 then
    raise exception using errcode = '22023', message = 'Intervalo de retry de infraestrutura invalido.';
  end if;
  if not public.is_publication_infrastructure_error(p_error_code, p_error_message) then
    raise exception using errcode = '22023', message = 'Erro informado nao e de infraestrutura.';
  end if;

  select item.* into item_row
  from public.publication_items item
  where item.id = p_item_id
    and item.claimed_by = trim(p_worker_id)
    and item.lease_until > timezone('utc', now())
    and item.status in ('preparing', 'publishing')
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Item nao esta sob lease deste worker';
  end if;

  next_count := coalesce(item_row.infrastructure_retry_count, 0) + 1;
  -- `p_delay_seconds` continua sendo o piso pedido por quem chama; o recuo so
  -- multiplica a partir dele. Expoente limitado em 5 para o teto sair em 900 s
  -- mesmo que a base mude.
  effective_delay := least(
    900,
    (p_delay_seconds * power(2, least(next_count - 1, 5)))::integer + floor(random() * 16)::integer
  );

  update public.publication_items item
  set status = 'waiting',
      claimed_by = null,
      lease_until = null,
      next_attempt_at = timezone('utc', now()) + make_interval(secs => effective_delay),
      attempt_count = greatest(0, item.attempt_count - case when item.creation_id is null then 1 else 0 end),
      infrastructure_retry_count = next_count,
      last_error_code = left(coalesce(nullif(trim(p_error_code), ''), 'infrastructure_retry'), 120),
      last_error_message = left(nullif(trim(p_error_message), ''), 1200)
  where item.id = item_row.id
  returning item.* into updated_row;

  -- Evento em toda repeticao ate a terceira, depois so de cinco em cinco: o
  -- comeco e o que se investiga, a repeticao longa so precisa de amostra.
  if next_count <= 3 or next_count % 5 = 0 then
    perform public.log_publication_item_event(
      updated_row.id, 'processing_deferred', item_row.status, updated_row.status,
      null, trim(p_worker_id), updated_row.last_error_code, updated_row.last_error_message,
      jsonb_build_object(
        'reason', 'infrastructure_retry',
        'creation_id_preserved', updated_row.creation_id is not null,
        'infrastructure_retry_count', next_count,
        'delay_seconds', effective_delay,
        'next_attempt_at', updated_row.next_attempt_at
      )
    );
  end if;

  return query select updated_row.id, updated_row.status, updated_row.creation_id, updated_row.next_attempt_at;
end;
$$;

revoke all on function public.defer_publication_infrastructure_failure(uuid, text, text, text, integer)
  from public, anon, authenticated;
grant execute on function public.defer_publication_infrastructure_failure(uuid, text, text, text, integer)
  to service_role;

notify pgrst, 'reload schema';

-- O contador precisa zerar quando o item avanca, e um gatilho e o lugar certo:
-- reemitir `defer_publication_item` e `complete_publication_item` inteiras --
-- duas funcoes de ~80 e ~100 linhas -- so para acrescentar uma atribuicao e
-- convite a divergencia silenciosa com a proxima migration que as tocar. Mesmo
-- raciocinio da 410.
--
-- O QUE CONTA COMO AVANCO, e por que nao e "mudou de status". O claim muda
-- `waiting -> preparing` em TODA reivindicacao, inclusive na que vai falhar de
-- infraestrutura logo em seguida. Um gatilho preso a status zeraria o contador
-- antes de cada incremento, e ele viveria eternamente em 1 -- o mesmo bug com
-- outra roupa. Os marcos abaixo sao escritos APENAS por quem realmente falou
-- com o provedor:
--
--   provider_creation_started_at mudou -> conteiner criado
--   container_poll_count subiu         -> consulta de status respondida
--   status virou terminal              -> publicado, falho ou removido
--
-- Nenhum deles e tocado pelo claim nem pelo adiamento de infraestrutura.
create or replace function public.reset_infrastructure_retry_on_progress()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.infrastructure_retry_count = 0 then
    return new;
  end if;
  -- Se ESTE update e o proprio adiamento de infraestrutura, ele acabou de
  -- incrementar; nao se desfaz o que ele fez.
  if new.infrastructure_retry_count > coalesce(old.infrastructure_retry_count, 0) then
    return new;
  end if;
  if new.provider_creation_started_at is distinct from old.provider_creation_started_at
    or coalesce(new.container_poll_count, 0) > coalesce(old.container_poll_count, 0)
    or (new.status in ('published', 'failed', 'removed') and new.status is distinct from old.status)
  then
    new.infrastructure_retry_count := 0;
  end if;
  return new;
end;
$$;

drop trigger if exists reset_infrastructure_retry_on_progress on public.publication_items;
create trigger reset_infrastructure_retry_on_progress
  before update on public.publication_items
  for each row
  execute function public.reset_infrastructure_retry_on_progress();

notify pgrst, 'reload schema';
