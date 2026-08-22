# Fase 08 — rollout e handoff

Status: `in_progress`

Entregas: ativação progressiva, fallback validado, monitoramento, comparação Instagram e handoff final. Gate: módulo independente, observável e reversível.

## Checkpoint de segurança anterior ao preview

- Migration 240 aplicada de forma aditiva e alinhada no remoto.
- Remoção de conexão agora libera somente holds que nunca iniciaram; holds ativos ou incertos permanecem para reconciliação.
- Leases expirados de analytics passam para `outcome_unknown`, sem retry cego.
- Os cinco workers consultam circuit breaker persistente próprio e registram sucesso/falha.
- Regras financeiras futuras possuem gestão somente por admin, combinação exata, eventos imutáveis e desativação sem exclusão.
- Teste SQL 240: 13/13 em transação com rollback; nenhum resíduo.
- Regressão: 163/163 testes, TypeScript e build aprovados; warnings metadata preexistentes permanecem fora do escopo.
- Commit de código: `1a74e4afd77f166674b05d43647d5abb1951bb38`.

Próximo gate: preview Vercel com todas as flags X desligadas e smoke test. Não promover para produção nem executar canário sem credencial X dedicada.
