-- Guarda de identidade Zernio também pela conta da API (accountId), além do username.
--
-- Contexto: a guarda da 113/153/154 compara apenas o username normalizado,
-- globalmente. Isso cobre o caso documentado em
-- plans/plano-correcao-definitiva-inventario-zernio-2026-08-16.md:88 de "username
-- repetido entre chaves" — a mesma conta Instagram cadastrada na Zernio como duas
-- contas distintas, com accountIds diferentes (ex.: `erishimizu67`, linha 254).
-- Essa cobertura NÃO é substituída aqui: trocar username por accountId deixaria
-- justamente esse caso passar e permitiria publicar duas vezes na mesma conta.
--
-- O que falta hoje é o outro eixo, também documentado na mesma linha 88: "accountId
-- repetido entre chaves". Existe unicidade por (organization_id, zernio_account_id)
-- desde a 053, mas ela é POR ORGANIZAÇÃO. A mesma conta Zernio pode hoje ser
-- vinculada em duas organizações diferentes sem nenhuma barreira.
--
-- Esta migration fecha esse eixo, mantendo o outro intacto. As duas guardas são
-- complementares, não alternativas.
--
-- Estado verificado antes de aplicar: 1.824 perfis Zernio ativos com accountId,
-- zero accountId repetido em qualquer organização. A guarda entra sem violação
-- pendente.

create or replace function public.prevent_zernio_instagram_identity_conflict()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  identity_value text;
  old_identity_value text;
  account_value text;
  old_account_value text;
begin
  if new.provider <> 'zernio' or new.deleted_at is not null then
    return new;
  end if;

  identity_value := lower(nullif(trim(regexp_replace(new.username, '^@', '')), ''));
  if identity_value is null then
    raise exception 'Identidade Instagram Zernio inválida.';
  end if;

  -- Eixo 1: conta da API (accountId), global.
  -- Avaliado antes da guarda de username porque o atalho de idempotência daquela
  -- retorna cedo quando o username não muda, e uma troca de accountId com o mesmo
  -- username escaparia da verificação.
  account_value := nullif(trim(new.zernio_account_id), '');
  if account_value is not null then
    old_account_value := case
      when tg_op = 'UPDATE' and old.provider = 'zernio' and old.deleted_at is null
        then nullif(trim(old.zernio_account_id), '')
      else null
    end;

    if old_account_value is distinct from account_value then
      -- Prefixo no lock evita colisão com o espaço de nomes do lock de username.
      perform pg_advisory_xact_lock(hashtextextended('zernio_account:' || account_value, 0));

      if exists (
        select 1
        from public.instagram_profiles profile
        where profile.provider = 'zernio'
          and profile.deleted_at is null
          and profile.id is distinct from new.id
          and nullif(trim(profile.zernio_account_id), '') = account_value
      ) then
        raise exception using
          errcode = '23505',
          message = 'A conta Zernio (accountId) já está vinculada a outro perfil ativo; resolva o conflito explicitamente.';
      end if;
    end if;
  end if;

  -- Eixo 2: username normalizado, global. Comportamento preservado da 154.
  if tg_op = 'UPDATE' then
    old_identity_value := lower(nullif(trim(regexp_replace(old.username, '^@', '')), ''));
    if old.provider = 'zernio'
       and old.deleted_at is null
       and old_identity_value is not distinct from identity_value then
      return new;
    end if;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(identity_value, 0));

  if exists (
    select 1
    from public.instagram_profiles profile
    where profile.provider = 'zernio'
      and profile.deleted_at is null
      and profile.id is distinct from new.id
      and lower(trim(regexp_replace(profile.username, '^@', ''))) = identity_value
  ) then
    raise exception using
      errcode = '23505',
      message = 'A identidade Instagram já está vinculada a outra conexão ou organização; resolva o conflito explicitamente.';
  end if;

  return new;
end;
$$;

revoke all on function public.prevent_zernio_instagram_identity_conflict() from public, anon, authenticated;

-- O trigger da 113 não observava zernio_account_id: uma troca de conta mantendo o
-- username não disparava guarda nenhuma. Recriado incluindo a coluna.
drop trigger if exists instagram_profiles_prevent_zernio_identity_conflict on public.instagram_profiles;
create trigger instagram_profiles_prevent_zernio_identity_conflict
before insert or update of username, provider, deleted_at, zernio_account_id on public.instagram_profiles
for each row execute function public.prevent_zernio_instagram_identity_conflict();

notify pgrst, 'reload schema';
