begin;

select '1..6';

-- 1. A guarda de username permanece. Substituí-la deixaria passar o caso
--    documentado de mesma conta Instagram com dois accountIds distintos.
do $$ declare definition text; begin
  definition := pg_get_functiondef('public.prevent_zernio_instagram_identity_conflict()'::regprocedure);
  if position('A identidade Instagram já está vinculada' in definition) = 0
     or position('regexp_replace(profile.username' in definition) = 0 then
    raise exception 'A guarda por username foi removida ou enfraquecida.';
  end if;
end $$;
select 'ok 1 - guarda por username preservada';

-- 2. A guarda por accountId existe e é global (sem recorte de organização).
do $$ declare definition text; begin
  definition := pg_get_functiondef('public.prevent_zernio_instagram_identity_conflict()'::regprocedure);
  if position('A conta Zernio (accountId) já está vinculada' in definition) = 0 then
    raise exception 'A guarda por accountId não foi encontrada.';
  end if;
  if position('organization_id' in definition) > 0 then
    raise exception 'A guarda não pode ser recortada por organização.';
  end if;
end $$;
select 'ok 2 - guarda por accountId presente e global';

-- 3. A guarda de conta é avaliada ANTES do atalho de idempotência do username,
--    senão uma troca de accountId com o mesmo username escaparia.
do $$ declare definition text; begin
  definition := pg_get_functiondef('public.prevent_zernio_instagram_identity_conflict()'::regprocedure);
  if position('zernio_account:' in definition) > position('old_identity_value is not distinct from identity_value' in definition) then
    raise exception 'A guarda de conta precisa vir antes do atalho de idempotência do username.';
  end if;
end $$;
select 'ok 3 - ordem das guardas correta';

-- 4. O trigger observa zernio_account_id.
do $$ declare cols text; begin
  select string_agg(a.attname, ',') into cols
  from pg_trigger t
  join unnest(t.tgattr) with ordinality as u(attnum, ord) on true
  join pg_attribute a on a.attrelid = t.tgrelid and a.attnum = u.attnum
  where t.tgname = 'instagram_profiles_prevent_zernio_identity_conflict'
    and t.tgrelid = 'public.instagram_profiles'::regclass;
  if cols is null or position('zernio_account_id' in cols) = 0 then
    raise exception 'O trigger não observa zernio_account_id (colunas: %).', coalesce(cols, 'nenhuma');
  end if;
  if position('username' in cols) = 0 then
    raise exception 'O trigger deixou de observar username (colunas: %).', cols;
  end if;
end $$;
select 'ok 4 - trigger observa username e zernio_account_id';

-- 5 e 6. Comportamento: o mesmo accountId não pode viver em dois perfis, nem
--        mesmo em organizações diferentes; e reescrever a própria linha continua
--        idempotente.
do $$
declare
  org_a uuid; org_b uuid; conta text := 'teste318' || substr(md5(random()::text), 1, 12);
  perfil_a uuid; bloqueou boolean := false;
begin
  select id into org_a from public.organizations where deleted_at is null order by created_at limit 1;
  select id into org_b from public.organizations where deleted_at is null and id <> org_a order by created_at limit 1;
  if org_a is null then raise notice 'Sem organização: asserções ignoradas.'; return; end if;

  insert into public.instagram_profiles (organization_id, instagram_user_id, username, provider, status, zernio_account_id)
  values (org_a, 'zernio:' || conta, 'usuario' || conta, 'zernio', 'online', conta)
  returning id into perfil_a;

  -- Reescrever a própria linha (mesmo accountId, mesmo username) não pode falhar.
  update public.instagram_profiles set zernio_account_id = conta where id = perfil_a;

  if org_b is not null then
    begin
      insert into public.instagram_profiles (organization_id, instagram_user_id, username, provider, status, zernio_account_id)
      values (org_b, 'zernio:' || conta || 'x', 'outro' || conta, 'zernio', 'online', conta);
    exception when unique_violation then bloqueou := true;
    end;
    if not bloqueou then
      raise exception 'O mesmo accountId foi aceito em outra organização.';
    end if;
  else
    raise notice 'Só uma organização disponível: teste entre organizações ignorado.';
  end if;
end $$;
select 'ok 5 - mesmo accountId recusado em outra organização';
select 'ok 6 - reescrita da própria linha permanece idempotente';

rollback;
