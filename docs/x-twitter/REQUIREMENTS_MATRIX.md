# Matriz final de requisitos — módulo X/Twitter

Atualizada em 2026-08-23T00:54:05Z. Esta matriz não substitui o plano; resume evidência e gates para continuidade segura.

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
| Workers/PM2 | Instalado e parado | Quatro papéis reais no release `e732fed77971-20260823T000341Z`; todos `stopped`; processos existentes intactos. |
| Publicação canário | Concluído | Texto, imagens, GIF, vídeo, URL e matriz de erros validados; wallet atual 11.725.000 micros. |
| Analytics manual | Implementado, gate externo bloqueado | Três operações retornaram HTTP 202, comprovadas sem cobrança e reconciliadas. Zero snapshot; não repetir cegamente. |
| Rollout geral/fallback live | Não iniciado por gate | Proibido até uma operação analytics distinta retornar sucesso comprovado/HTTP 200 com snapshot e liquidação correta. |

## Estado operacional congelado

- Todas as flags X e fallback estão off.
- Production: `dpl_Cvbbi7kWV7w32ct71frjGR3SfRSj`, `READY`, alias oficial.
- Preview: `dpl_2stTwHisyFgd6GfNFvCMihRJqZYs`, `READY`.
- Supabase local/remoto alinhado até 243.
- Publicação/analytics não terminais 0; holds 0; snapshots 0; transferências 0.
- Wallet: 11.725.000 micros contábeis, 0 reservado, versão 21.
- Quatro workers X `stopped`; seis processos existentes `online` com PIDs preservados.

## Única próxima ação autorizada pelo plano

Obter da Zernio confirmação/evidência de que o endpoint de analytics para X passou a concluir com sucesso. Só então preparar um canário novo e distinto seguindo `phases/07-analytics.md`. Não repetir os três recursos já tentados, não liberar/liquidar por suposição e não habilitar rollout geral para contornar o gate.
