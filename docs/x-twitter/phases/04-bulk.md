# Fase 04 — postagem em massa

Status: `completed`

Entregas: composer, contador, rotação, agenda, review, confirm, reservas parciais e excedente compacto. Gate: concorrência/idempotência aprovadas sem publicar.

Início: 2026-08-22T17:48:00Z. Nenhuma chamada de publicação Zernio faz parte desta fase.

Validação local: migration/teste 228, revisão assinada sem reserva, confirmação RPC transacional, programas/textos/conjuntos/itens/excedente, UI somente em massa e APIs `/api/x/bulk/*`. 154/154 testes, TypeScript e build aprovados; dry-run lista somente 228. Nenhuma chamada externa, Vercel ou VPS.

Gate remoto: migration 228 aplicada. O primeiro teste informou 15/16 por defeito do cenário (payload concorrente vazio era rejeitado antes do snapshot); o teste foi corrigido sem alteração de schema e passou 16/16. Reservas agregadas totalizaram exatamente 215.000 micros para posts de 15.000 + 200.000, sem débito contábil. Replay não duplicou programa/item; snapshot velho foi rejeitado. Rollback deixou zero dados. Lint sem erro X.
