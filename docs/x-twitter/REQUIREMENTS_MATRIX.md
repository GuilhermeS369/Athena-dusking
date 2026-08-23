# Matriz final de requisitos — módulo X/Twitter

Atualizada em 2026-08-23T12:05:47Z. Esta matriz não substitui o plano; resume evidência e gates para continuidade segura.

| Área | Estado | Evidência / observação |
|---|---|---|
| Isolamento Instagram/X | Concluído | Namespaces `/x/*`, `/api/x/*`, `twitter_*`, bucket e quatro workers exclusivos; testes proíbem tabelas/RPCs operacionais Instagram. |
| Menus e páginas | Concluído | Instagram e X/Twitter expansíveis; Dashboard e Importação em massa gerais; nove páginas X presentes. |
| Postagem em massa | Concluído e off | Somente fluxo em massa; textos/mídias/agenda/review/confirm implementados. Contrato financeiro corrigido em `b37e09f`. |
| Caracteres e preço | Concluído | URL=23, emoji=2, Free=280, fallback 280, Premium somente por capacidade persistida; US$ 0,015 ou US$ 0,200 total. |
| Carteira/ledger/reservas | Concluído | Micros inteiros, grant global, rate card, confirmação atômica, reservas/holds/ledger e idempotência testados. |
| Saldo baixo | Concluído | Round-robin determinístico, procura slots baratos, excedente compacto e não retomável automaticamente. |
| Cancelamento | Concluído | Item/programa/perfil/grupo, liberação idempotente e `outcome_unknown` preservado para reconciliação. |
| Logs e decisões financeiras | Concluído | Página X independente, resolução individual justificada e regras futuras somente Admin. |
| Zernio/identidades/perfis | Concluído e off | Único conector X, identidade global, transferência auditada, épocas, remoção/reativação e sync dedicado. |
| Galeria e grupos | Concluído | Upload TUS direto, mídia congelada preservada ao excluir, grupos editáveis e tenant isolation. |
| Agenda, fila e perfis | Concluído | Páginas locais, filtros/cancelamentos e detalhe estável com histórico/snapshots sem leitura automática. |
| Workers/PM2 | Instalado e parado | Quatro papéis reais no release `d67a2ec-20260823T113709Z`; todos `stopped`; seis processos existentes intactos. Fallback Vercel é separado e não é processo PM2. |
| Publicação canário | Concluído | Texto, imagens, GIF, vídeo, URL e matriz de erros validados; wallet atual 11.725.000 micros. |
| Analytics manual | HTTP 200 comprovado; billing pendente | Novo item fan-out recebeu HTTP 200 e métricas. Reserva máxima 45.000 está aberta; baseline e contador atual permanecem 27 reads. Sem snapshot/débito/retry até o metering provar o delta exato. |
| Rollout geral/fallback live | Preflight iniciado; expansão bloqueada | Sete de nove itens do gate zero aprovados. Faltam liquidação/snapshot do HTTP 200 e health `ok` sem unknown; nenhuma organização adicional ou fallback live autorizado. |
| CSS/UX responsivo do módulo X | Concluído | Shell e estilos específicos escopados em `.twitter-module-shell`. Matriz autenticada 10 rotas × 5 larguras aprovada localmente e repetida em Production canário; sem overflow, alvos mínimos de 44 px e foco visível. Postagem Instagram validada em desktop/mobile fora do wrapper X. |

## Estado operacional congelado

- Todas as flags mutáveis X e fallback estão off; Pomodoro permanece na lista canário do módulo.
- Production: `dpl_sZ28EuSUeQXRy8f3sJdyrmFbooch`, `READY`, alias oficial. Rollback anterior: `dpl_oQRbJB2QkTw33G2s69VTucJpgK5D`.
- Preview: `dpl_7nHd2NqnixMUCHq51d2czH3Fkiqc`, `READY`.
- Supabase local/remoto alinhado até 246.
- Publicação não terminal 0; Analytics unknown 1; reserva aberta 1; snapshots 0; breakers abertos 0; HTTP 429 em 24 h 0.
- Wallet: 11.590.000 micros contábeis, 45.000 reservado, versão 25. O hold pertence somente ao canário HTTP 200 aguardando billing.
- Quatro workers X `stopped`; seis processos existentes `online` com PIDs preservados.

## Única próxima ação autorizada pelo plano

Executar somente a auditoria de billing do item registrado em `STATE.json`. Quando `posts_read > 27` e o valor estiver estável, liquidar exatamente o delta, criar o snapshot com as métricas já preservadas e liberar o excedente da reserva. Depois repetir health; não chamar Analytics novamente nem habilitar rollout para contornar o gate.
