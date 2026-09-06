-- /meta voltou a carregar: faltava o grant das colunas novas de bloqueio.
--
-- O SINTOMA. A tela morria com "Application error: a server-side exception has
-- occurred" -- tela preta, sem nada aproveitavel. O `throw` em
-- app/(painel)/meta/page.tsx derruba o render inteiro quando a consulta de apps
-- falha, e a mensagem nao dizia qual consulta nem qual codigo.
--
-- A CAUSA, e ela e sutil o bastante para merecer estar escrita. `meta_apps_safe`
-- e `security_invoker = true`: quem le a view precisa ter privilegio nas colunas
-- da TABELA por baixo, nao na view. E `meta_apps` nao tem grant de tabela
-- inteira para `authenticated` -- tem grant POR COLUNA, uma lista fixa de 11
-- nomes escrita na migration 366, justamente para que `encrypted_app_secret`
-- nunca saia por PostgREST.
--
-- A migration 392 acrescentou as seis colunas de bloqueio de API em
-- `public.meta_apps`, e a 396 as expos na view. Nenhuma das duas estendeu o
-- grant por coluna -- e grant por coluna nao cresce sozinho quando a tabela
-- cresce. Resultado: todo SELECT autenticado que tocasse qualquer coluna
-- `api_block_*` batia em permission denied na tabela base, e a pagina inteira
-- caia junto.
--
-- POR QUE ISSO NAO APARECEU EM TESTE. `service_role` ignora grant de coluna.
-- Qualquer verificacao feita com a chave de servico -- que e como se inspeciona
-- o banco daqui -- responde "ok" para exatamente a consulta que quebra em
-- producao. O unico jeito de ver a falha e lendo como `authenticated`.
--
-- O PRECEDENTE ESTAVA NA PROPRIA 366, linha 124: quando `meta_app_id` foi
-- acrescentada a `instagram_profiles` para alimentar outra view security_invoker,
-- foi preciso um `grant select (meta_app_id)` explicito. Mesmo mecanismo, mesma
-- armadilha.
--
-- REGRA PARA A PROXIMA VEZ: coluna nova exposta em `meta_apps_safe` precisa de
-- duas linhas, nao uma -- a da view e a do grant por coluna aqui embaixo.

grant select (
  api_blocked_at,
  api_block_until,
  api_block_error_message,
  api_block_window_count,
  api_block_ignored_count,
  api_last_unblocked_at
) on public.meta_apps to authenticated;

-- Deliberadamente FORA da lista: `api_block_detected_item_id` e
-- `api_unblocked_by` existem na tabela (migration 392) mas a view nao as expoe.
-- Conceder o que a projecao segura nao mostra so aumentaria a superficie sem
-- ninguem precisar.

notify pgrst, 'reload schema';
