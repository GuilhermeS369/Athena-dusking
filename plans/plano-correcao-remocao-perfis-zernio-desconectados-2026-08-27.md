# Correção e remoção de perfis Zernio desconectados

## Objetivo

Corrigir o erro PostgreSQL `42804` que reverte a rotina de desconexão, impedir que projeções de observabilidade interrompam operações autoritativas e executar a remoção canônica global dos perfis com sinal terminal `account_disconnected` ou `auth_expired` comprovado pela Zernio.

Snapshot inicial de 27/08/2026: 20 perfis ativos afetados em duas organizações — Pomodoro (8) e Vini farmando cash (12) — com mais de mil itens pendentes ou falhados. O inventário deve ser refeito imediatamente antes da aplicação porque novos sinais podem surgir.

## Mudanças

1. Criar uma migration corretiva aditiva que:
   - tipa explicitamente os enums usados pelo trigger de desconexão;
   - transforma todas as projeções envolvidas em best-effort, sem permitir que falhas de logs revertam contenção ou remoção;
   - contém imediatamente o perfil após sinal terminal, marcando-o offline e retirando a fila elegível de circulação;
   - preserva a remoção canônica: `DELETE /v1/accounts/{id}`, soft-delete no Athena, remoção dos grupos, cancelamento de geração futura e ressincronização dos lotes;
   - mantém retry e dead-letter para falhas remotas, sem recolocar o perfil na fila.

2. Corrigir a Central de Logs:
   - resolver `profile_id` das anomalias por `publication_item_id`;
   - separar incidentes por perfil e `provider_code`;
   - classificar desconexão terminal como contenção/remoção automática;
   - reconstruir somente as projeções derivadas recentes, preservando as fontes autoritativas.

3. Disponibilizar recuperação global idempotente:
   - selecionar apenas códigos exatos `account_disconnected` e `auth_expired` na telemetria da Zernio;
   - abranger todas as organizações e somente perfis Zernio ativos;
   - não usar o erro secundário `42804` isoladamente como autorização de remoção;
   - reutilizar um único incidente e job por organização/perfil.

4. Criar utilitário administrativo com modos `dry-run`, `apply`, `drain` e `report`, gerando backup JSON antes da primeira mutação.

## Execução segura

1. Validar migration, testes SQL, testes Node e build local.
2. Parar temporariamente os workers de publicação e geração.
3. Gerar backup e dry-run global.
4. Aplicar a migration e repetir o dry-run.
5. Executar `apply` e `drain` em lotes pequenos até não restarem jobs pendentes.
6. Validar perfis, grupos, filas, reservas, planos, lotes, incidentes e resultados remotos.
7. Reiniciar os workers e observar ao menos dois ciclos completos.

## Critérios de aceite

- Nenhuma nova ocorrência de `42804` no fluxo de desconexão.
- Nenhum perfil ativo com sinal terminal confirmado no período auditado.
- Nenhum item publicável associado aos perfis removidos.
- Respostas remotas `200` e `404` concluem a remoção; falhas temporárias entram em retry; falhas terminais ficam em dead-letter.
- Reexecutar recuperação não duplica incidentes, jobs, eventos ou remoções concluídas.
- Perfis saudáveis e publicações concluídas permanecem intactos.

## Decisões fixadas

- Remoção canônica completa: Zernio, soft-delete no Athena, desvínculo de grupos e contenção da fila.
- Abrangência global, em todas as organizações.
- Somente `account_disconnected` e `auth_expired` comprovados pela telemetria autorizam remoção automática.
- Eventos-fonte e publicações concluídas são preservados para auditoria.

## Resultado da execução — 27/08/2026

- Migration `285_fix_zernio_terminal_disconnection_cleanup.sql` aplicada em produção.
- O inventário final cresceu para 22 perfis antes da pausa dos workers: Pomodoro (9) e Vini farmando cash (13).
- 170 sinais terminais exatos foram preservados como evidência e 749 projeções de observabilidade foram reconstruídas.
- 1.238 itens elegíveis foram contidos e ficaram fora da fila publicável.
- 22 exclusões remotas concluíram como `remote_deleted`; 22 incidentes e 22 jobs ficaram `completed`.
- Os 22 perfis ficaram offline com soft-delete e foram removidos de todos os grupos.
- Validação final: zero perfis ativos do lote, zero itens elegíveis, zero vínculos de grupo e zero novas ocorrências `42804`.
- Os workers de publicação, geração e sincronização Zernio foram reiniciados e permaneceram online após a observação.
