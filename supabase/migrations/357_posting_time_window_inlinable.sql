-- posting_time_window escrita para o planner conseguir INLINE.
--
-- A primeira versão (migration 356) custava caro do jeito mais bobo possível:
-- get_posting_composer_profile_summaries a chama uma vez por item agendado
-- (~184 mil na organização Pomodoro) e, medido em 02/09/2026 contra o banco de
-- produção, a função de resumos ficou em 4,35 s de mediana contra 1,86 s da
-- agregação equivalente sem ela — 2,5 s só de chamada de função.
--
-- Duas coisas na definição anterior impediam o planner de embutir o corpo na
-- consulta, e cada uma sozinha já bastaria:
--
--   1. a cláusula `set search_path = public`. Uma função SQL com SET nunca é
--      inlined: o SET precisa ser aplicado e desfeito a cada chamada, então ela
--      vira 184 mil chamadas de função de verdade, cada uma com troca de
--      contexto de configuração;
--   2. o corpo em forma de `select ... from (...) where ...`. O inline só
--      alcança corpo de expressão simples; qualquer FROM/WHERE o desqualifica.
--
-- Esta versão é uma expressão só e sem SET. Em troca do SET, os nomes vêm
-- qualificados por pg_catalog — que é o que o SET protegia. `at time zone` e
-- `overlay(... placing ... from ...)` são sintaxe do parser, resolvidas em
-- pg_catalog antes do search_path, e a função não é security definer: roda com
-- o privilégio de quem chama.
--
-- O truncamento de dez minutos agora sai de um to_char só: 'HH24:MI' dá
-- '18:27', e trocar o quinto caractere por '0' dá '18:20'. O resultado é o
-- mesmo caractere a caractere do extract/lpad anterior — e o mesmo de
-- lib/publications/composer.ts#postingTimeWindow, que continua sendo a
-- definição de referência.
create or replace function public.posting_time_window(p_at timestamptz)
returns text
language sql
stable
parallel safe
as $$
  select overlay(pg_catalog.to_char(p_at at time zone 'America/Sao_Paulo', 'HH24:MI') placing '0' from 5);
$$;

revoke all on function public.posting_time_window(timestamptz) from public, anon;
grant execute on function public.posting_time_window(timestamptz) to authenticated, service_role;
