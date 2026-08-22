# Fase 04 — postagem em massa

Status: `completed`

Entregas: composer, contador, rotação, agenda, review, confirm, reservas parciais e excedente compacto. Gate: concorrência/idempotência aprovadas sem publicar.

Início: 2026-08-22T17:48:00Z. Nenhuma chamada de publicação Zernio faz parte desta fase.

Validação local: migration/teste 228, revisão assinada sem reserva, confirmação RPC transacional, programas/textos/conjuntos/itens/excedente, UI somente em massa e APIs `/api/x/bulk/*`. 154/154 testes, TypeScript e build aprovados; dry-run lista somente 228. Nenhuma chamada externa, Vercel ou VPS.

Gate remoto: migration 228 aplicada. O primeiro teste informou 15/16 por defeito do cenário (payload concorrente vazio era rejeitado antes do snapshot); o teste foi corrigido sem alteração de schema e passou 16/16. Reservas agregadas totalizaram exatamente 215.000 micros para posts de 15.000 + 200.000, sem débito contábil. Replay não duplicou programa/item; snapshot velho foi rejeitado. Rollback deixou zero dados. Lint sem erro X.

Auditoria final em 22/08/2026: removida a materialização do calendário inteiro. Uma janela de 90 dias/1 minuto agora mantém apenas `count/first/last` e gera no máximo os itens que o saldo financia; cenário realista máximo comprovado em 3,4 ms para 129.601 slots solicitados e 800 itens financiados. A revisão passou a exibir saldos contábil/reservado/disponível/final, custo com/sem URL e distribuição por perfil; perfis abaixo de 15.000 micros aparecem sem saldo e não podem ser selecionados.
