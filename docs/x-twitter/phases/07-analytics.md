# Fase 07 — análises manuais

Status: `in_progress` — implementação concluída; canário pago mínimo pendente

## Entregas

- `/x/analises` seleciona posts e perfis com checkbox.
- Quote é somente leitura, assinado e válido por dez minutos.
- Confirmação bloqueia todas as carteiras, revalida versões e preserva US$ 5,00 além de reservas existentes.
- Post custa 5.000 micros; perfil/followers custa 10.000 micros.
- Worker analytics usa rotas, flag, heartbeat e endpoints Zernio próprios.
- Sucesso liquida somente o recurso e cria snapshot local; falha confirmada libera; incerto mantém hold.
- Dashboard X lê apenas snapshots locais e nunca dispara coleta.
- `/x/logs` permite resolver analytics incerta com justificativa auditada.

## Evidências

- Migration 235–240 aplicadas; Supabase alinhado até 240.
- Teste SQL 26/26 com rollback e zero resíduos na implementação.
- Baseline atual: 166/166 testes Node, TypeScript, build e diff check aprovados.
- Lint sem achados X; achados legados inalterados.
- Nenhuma chamada real Zernio foi feita; flags analytics permanecem off.

Checkpoint 2026-08-22T21:37:58Z: documentação oficial reconfirmou HTTP 202 para sync pendente. Worker corrigido em `46e09cc` para manter hold sem snapshot/retry; release VPS `46e09cc-20260822T213610Z`. Quote read-only de um post aprovou custo 5.000, projeção 11.720.000 e piso 5.000.000; wallet permaneceu 11.725.000/0 versão 15 e nenhuma entidade analytics foi criada.

## Rollback

- Manter `TWITTER_ANALYTICS_ENABLED=false` e `TWITTER_ANALYTICS_WORKER_ENABLED=false`.
- Parar apenas `athena-twitter-analytics-worker` quando instalado.
- Banco recebe somente correção forward-only; código pode ser revertido pelo commit da fase.

## Próxima ação segura

Confirmar a reserva de uma leitura de post por 5.000 micros com analytics/worker ainda desligados; auditar job/item/reserva antes da janela live.
