-- Teto de 7 dias por plano de programação em massa.
--
-- Contexto: a migration 328 removeu a janela móvel de 48h da geração, para que
-- um plano de 3 dias gere 3 dias de uma vez e o gerador possa ficar ocioso em
-- seguida, em vez de disputar banco para sempre com as publicações do momento.
-- Com isso, o horizonte deixou de funcionar acidentalmente como freio de
-- tamanho. O piso de 29 minutos (328) cobre o erro de intervalo; este teto
-- cobre o erro de duração.
--
-- Sem ele, `duration_days` não tem limite algum: o schema original só exige
-- `> 0` (084:20) e a aplicação só valida que é inteiro positivo. Um plano de
-- 365 dias com a frota atual passaria de 20 milhões de linhas materializadas de
-- uma vez.
--
-- POR QUE UM GATILHO DE INSERT E NÃO UMA CHECK CONSTRAINT:
-- já existem planos legítimos com duração acima de 7 dias, todos concluídos
-- (dois de 20 dias em 15/08, vários de 9 e 10 dias). Uma CHECK falharia na
-- validação da tabela; e mesmo declarada NOT VALID ela passaria a ser exigida
-- em qualquer UPDATE dessas linhas antigas — `refresh_bulk_rotation_plan_state`,
-- pausa operacional e cancelamento por escopo escrevem em planos existentes e
-- passariam a estourar. Um gatilho BEFORE INSERT preserva o histórico intacto e
-- limita apenas o que for criado daqui para frente.

create or replace function public.enforce_bulk_plan_duration_cap()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.duration_days > 7 then
    raise exception using errcode = '22023',
      message = 'A duração máxima de uma programação em massa é de 7 dias.';
  end if;
  return new;
end;
$$;

drop trigger if exists bulk_publication_plans_enforce_duration_cap on public.bulk_publication_plans;
create trigger bulk_publication_plans_enforce_duration_cap
before insert on public.bulk_publication_plans
for each row execute function public.enforce_bulk_plan_duration_cap();

revoke all on function public.enforce_bulk_plan_duration_cap() from public;

notify pgrst, 'reload schema';
