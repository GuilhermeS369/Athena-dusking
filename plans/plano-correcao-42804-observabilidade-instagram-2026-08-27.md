# Plano de correção do erro 42804 na observabilidade Instagram

## Objetivo

Eliminar a incompatibilidade entre expressões `text` e os enums da observabilidade Instagram, garantindo que qualquer falha de telemetria seja best-effort e nunca reverta uma transação autoritativa.

## Restrição operacional obrigatória

As publicações atingidas pelo erro `42804` não podem ser reenfileiradas, reabertas, reagendadas ou repostadas. Seus registros e eventos devem permanecer disponíveis para auditoria.

## Fases

1. Inventariar migrations, alterações locais e todos os itens afetados.
2. Corrigir tipagem e isolamento das projeções de observabilidade.
3. Adicionar e executar testes de regressão.
4. Revalidar os dados protegidos e revisar o rollout.
5. Aplicar apenas migrations validadas e executar smoke checks.
6. Monitorar recorrência, resolver o incidente e encerrar a documentação.

## Critérios de conclusão

- Zero novas ocorrências `42804` após o rollout.
- Nenhum item protegido ganha `creation_id`, `published_at` ou `next_attempt_at`.
- Nenhum item protegido tem aumento de `attempt_count`.
- As projeções de publicação, sincronização, desconexão e anomalia Zernio são best-effort.
- O histórico operacional permanece preservado.

