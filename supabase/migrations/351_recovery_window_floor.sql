-- Tela de Recuperacao — piso da janela de analise.
--
-- A 347 gravou `window_days between 7 and 180`. O piso de 7 era um palpite meu,
-- e ele bloqueia um uso legitimo: reproduzir a janela de uma analise passada
-- para comparar maca com maca. A analise de 31/08/2026 cobriu 25 a 31/08 com o
-- dia 31 descartado por ser parcial — ou seja, seis dias efetivos, que a
-- restricao recusa.
--
-- O piso certo e 3, e nao 1, pelo motivo que a propria analise registra na
-- armadilha "julgar por um dia so": um unico dia produz dois tercos de falso
-- positivo, porque um perfil que ja fez 3,3x a mediana cai por um dia fraco.
-- Tres dias e o minimo que ainda deixa a mediana significar alguma coisa.
--
-- O gate de julgabilidade continua sendo contado em POSTS, nunca em dias — um
-- perfil que posta 40 vezes ao dia chega aos 60 posts em dois dias, e a janela
-- em dias so delimita o material disponivel.

alter table public.recovery_analysis_runs
  drop constraint if exists recovery_analysis_runs_window_days_check;

alter table public.recovery_analysis_runs
  add constraint recovery_analysis_runs_window_days_check
  check (window_days between 3 and 180);

notify pgrst, 'reload schema';
