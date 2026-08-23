# Matriz final de requisitos — módulo X/Twitter

Atualizada em 2026-08-23T02:03:07Z. Esta matriz não substitui o plano; resume evidência e gates para continuidade segura.

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
| Analytics manual | Implementado, gate de sucesso/fan-out bloqueado | Três operações retornaram HTTP 202 e zero snapshot; billing tardio confirmou 27 reads/US$ 0,135 e foi reconciliado. Capability Athena passou em janela curta com delta zero, mas HTTP 200 e custo real por seleção ainda não foram provados. |
| Rollout geral/fallback live | Não iniciado por gate | Proibido até uma operação analytics distinta retornar sucesso comprovado/HTTP 200 com snapshot e liquidação correta. |
| CSS/UX responsivo do módulo X | Matriz autenticada local aprovada; Preview final pendente | Shell e estilos específicos estão escopados em `.twitter-module-shell`. Foram aprovados 50 casos reais: 10 rotas × 1440/1024/768/390/320 px, sem overflow, com alvos de 44 px e foco visível. O Preview protegido não aceitou a sessão Athena; falta publicar o checkpoint corrigido e validar build/redirecionamento antes de Production. |

## Estado operacional congelado

- Todas as flags X e fallback estão off.
- Production: `dpl_Cvbbi7kWV7w32ct71frjGR3SfRSj`, `READY`, alias oficial.
- Preview: `dpl_2stTwHisyFgd6GfNFvCMihRJqZYs`, `READY`.
- Supabase local/remoto alinhado até 245.
- Publicação/analytics não terminais 0; holds 0; snapshots 0; transferências 0.
- Wallet: 11.590.000 micros contábeis, 0 reservado, versão 24; reconciliação tardia debitou 135.000 e o canário reservou/liberou 6.590.000 sem débito.
- Quatro workers X `stopped`; seis processos existentes `online` com PIDs preservados.

## Única próxima ação autorizada pelo plano

Publicar o checkpoint CSS corrigido em Preview, mantendo flags mutáveis off. Para Analytics, primeiro redesenhar quote/confirm para possível fan-out do provedor; não repetir os três endpoints já tentados nem habilitar rollout geral para contornar o gate.
