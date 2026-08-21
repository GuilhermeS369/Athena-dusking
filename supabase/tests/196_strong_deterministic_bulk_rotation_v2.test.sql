begin;

do $$
declare
  media_count constant bigint := 159;
  seed constant text := 'rotacao-v2-teste';
  first_offset bigint;
  second_offset bigint;
  first_step bigint;
  second_step bigint;
  first_cycle_count bigint;
  second_cycle_count bigint;
  shifted_matches bigint;
begin
  first_offset := public.bulk_rotation_v2_profile_offset(seed, 65, media_count);
  second_offset := public.bulk_rotation_v2_profile_offset(seed, 66, media_count);
  first_step := public.bulk_rotation_v2_profile_step(seed, 65, media_count);
  second_step := public.bulk_rotation_v2_profile_step(seed, 66, media_count);

  if first_offset < 0 or first_offset >= media_count or second_offset < 0 or second_offset >= media_count then
    raise exception 'offset v2 saiu do domínio das mídias';
  end if;
  if gcd(first_step, media_count) <> 1 or gcd(second_step, media_count) <> 1 then
    raise exception 'passo v2 precisa ser coprimo para cobrir o ciclo inteiro';
  end if;
  if first_step = second_step then
    raise exception 'perfis vizinhos não deveriam usar o mesmo passo';
  end if;

  select count(distinct mod(first_offset + slot * first_step, media_count))
  into first_cycle_count from generate_series(0::bigint, media_count - 1) slot;
  select count(distinct mod(second_offset + slot * second_step, media_count))
  into second_cycle_count from generate_series(0::bigint, media_count - 1) slot;
  if first_cycle_count <> media_count or second_cycle_count <> media_count then
    raise exception 'cada perfil v2 precisa percorrer todas as mídias uma vez por ciclo';
  end if;

  select count(*) into shifted_matches
  from generate_series(0::bigint, 88) slot
  where mod(first_offset + slot * first_step, media_count)
    = mod(second_offset + (slot + 1) * second_step, media_count);
  if shifted_matches >= 10 then
    raise exception 'perfis vizinhos ainda se comportam como cópias deslocadas: %/89', shifted_matches;
  end if;
end;
$$;

rollback;
