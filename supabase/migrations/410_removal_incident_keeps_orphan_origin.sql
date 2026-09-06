-- Remover um perfil órfão deixa de apagar de qual app ele veio.
--
-- O QUE ACONTECEU EM 06/09/2026. Depois de marcar 22 perfis com a origem do app
-- que os havia soltado (migration 407), o operador mandou removê-los. A remoção
-- rodou pela rotina certa -- `enqueue_instagram_profile_removal`, a mesma de
-- /perfis --, e o incidente saiu com `meta_app_id` e `meta_app_label_snapshot`
-- NULOS: ela lê a origem de `profile.meta_app_id`, que num órfão é nulo por
-- definição.
--
-- Resultado: os 22 caíram no balde anônimo da tela -- "(sem rótulo guardado)" --
-- horas depois de eu ter corrigido justamente esse balde. A informação existia
-- em `orphaned_from_meta_app_label`, no próprio perfil, e foi descartada na
-- passagem.
--
-- POR QUE UM GATILHO E NÃO EDITAR A ROTINA. São três funções que inserem neste
-- rastro -- a queda automática, a remoção pedida e a exclusão de grupo -- e
-- todas leem `profile.meta_app_id` do mesmo jeito. Consertar uma deixaria as
-- outras com o mesmo buraco, e reemitir as três, cada uma com quase duzentas
-- linhas, para mudar uma atribuição é troca ruim: o risco de transcrição passa
-- a ser maior que o bug. O gatilho preenche o que faltou, uma vez, para
-- qualquer caminho -- inclusive os que ainda não existem.
--
-- Ele só age quando a coluna chega nula. Origem informada por quem inseriu
-- nunca é sobrescrita.
create or replace function public.fill_meta_incident_orphan_origin()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  profile_row public.instagram_profiles%rowtype;
begin
  if new.meta_app_id is not null and nullif(trim(coalesce(new.meta_app_label_snapshot, '')), '') is not null then
    return new;
  end if;

  select * into profile_row
  from public.instagram_profiles profile
  where profile.id = new.profile_id;
  if not found then
    return new;
  end if;

  if new.meta_app_id is null then
    new.meta_app_id := profile_row.orphaned_from_meta_app_id;
  end if;
  if nullif(trim(coalesce(new.meta_app_label_snapshot, '')), '') is null then
    new.meta_app_label_snapshot := coalesce(
      profile_row.orphaned_from_meta_app_label,
      (select app.label from public.meta_apps app where app.id = new.meta_app_id)
    );
  end if;

  return new;
end;
$$;

drop trigger if exists meta_incident_fill_orphan_origin on public.meta_profile_disconnection_incidents;
create trigger meta_incident_fill_orphan_origin
  before insert or update of meta_app_id, meta_app_label_snapshot
  on public.meta_profile_disconnection_incidents
  for each row
  execute function public.fill_meta_incident_orphan_origin();

notify pgrst, 'reload schema';
