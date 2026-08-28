# Esteira Athena de publicação v2 — 2026-08-24

## Decisão

- O Athena continua sendo a fonte de verdade do agendamento.
- A Zernio recebe somente `publishNow` no momento do despacho; não há agendamento remoto antecipado.
- A preparação é local, móvel e limitada às próximas 24 horas. Item criado dentro da janela entra imediatamente.
- URL assinada é criada e sondada somente no despacho final.
- `execute_at` libera o item para a fila; atraso superior a 120 segundos gera SLA e não muda o item para `ignored`.
- Itens anteriores à curta janela operacional do corte permanecem legados e não são republicados.
- `creation_id` sempre segue para polling/reconciliação, nunca para nova criação.

## Implementação

- Migration `264_athena_publication_pipeline_v2.sql`:
  - versiona a esteira sem reescrever todo o histórico;
  - migra agendamentos futuros existentes sem alterar lote, perfil, horário ou conteúdo;
  - adiciona leases independentes para preparação;
  - usa `FOR UPDATE SKIP LOCKED` e ordenação justa por organização/perfil;
  - persiste e resolve alertas agregados de SLA;
  - preserva o corte legado contra republicação do incidente.
- Migration `265_publication_v2_sla_operational_alert.sql` expõe o SLA v2 na Central Operacional como alerta agregado e deixa explícito que os itens não foram descartados.
- Worker direto:
  - prepara perfil, conexão, mídia, formato e capa sem chamada ao provedor;
  - mantém as sondagens HEAD/GET Range e a quarentena de mídia existentes;
  - mantém os classificadores terminais exatos de Zernio e Meta;
  - aplica concorrência adaptativa sob 429, timeout, rede e 5xx;
  - preserva a capa de Reel com URL fresca no despacho.
- Fallback da aplicação recebeu a mesma preparação local e os classificadores terminais; o deploy da aplicação deve respeitar o fluxo normal do repositório, pois o worktree contém outras mudanças em andamento.

## Validação

- 27 testes do dispatcher aprovados.
- 26 contratos SQL novos aprovados no Supabase local.
- Cenários transacionais de 500 e 1.000 perfis no mesmo slot aprovaram 1.500/1.500 claims, com 750 Reels, 750 Stories e zero descarte por atraso.
- Cancelamento de lote com 1.000 itens aprovado em uma única mutação local, sem chamada ou telemetria Zernio; um item já em processamento bloqueia o lote inteiro sem cancelamento parcial.
- `npx tsc --noEmit` aprovado.
- `npm run build` aprovado; somente avisos preexistentes de metadata.
- Dry-run remoto indicou somente a migration 264.
- Snapshot fixo de 23.245 agendamentos futuros preservado antes/depois:
  - SHA-256: `35ab3daaec08de1c16374d9f38749143bbee353f88078bb9d9a48901c455e219`.
- Snapshot de 50.671 pares com criação antes do corte:
  - SHA-256: `a3d53593f38e630b8a4006b0863ac75f21dfc2bd42c1b0dd8febea41b0c0dba9`.
- Primeira janela v2 observada em produção:
  - 30 itens v2;
  - 30 `published`;
  - zero `ignored` v2;
  - alerta de SLA registrado após 120 segundos sem retirar itens da fila.
- Monitoramento continuado até 19:35 UTC confirmou heartbeat saudável, zero lease expirado, preparação avançando e novas publicações concluídas. Os `ignored` v2 observados pertencem exclusivamente ao classificador terminal preservado `zernio_account_disconnected`, não ao SLA.

## Produção e rollback

- Migrations 264 e 265 aplicadas e alinhadas local/remoto.
- O painel `/operacao` passou a receber o alerta `publication_v2_sla` pela RPC já usada em produção, sem exigir deploy web.
- Fallback web implantado na Vercel Production: `dpl_3HpYrfZ1zRzPVAyf6X275C6zKNJY` (`READY`).
- Worker `athena-publication-worker` reiniciado isoladamente, online em modo `direct`, `dry_run=false`.
- Hashes implantados:
  - dispatcher: `eb8b4acdbe79da55e1c587de23ef78a25d0e82e3dd8fa3a73906f46b6faa2969`;
  - worker: `c0aab886a45d6f7e6b47cf10be85f5486850feea6e99aa65808e01911378e325`.
- Backups na VPS:
  - `/opt/athena-worker/scripts/workers/publication-direct-dispatch.mjs.backup-20260824T1908Z`;
  - `/opt/athena-worker/scripts/workers/publication-worker.mjs.backup-20260824T1908Z`.
- Banco é forward-only. Em rollback, restaurar os dois arquivos do worker e criar migration corretiva; nunca reabrir `ignored` histórico.

## Reconciliação GG Igor

- Lote `4d7a001e-a9d7-41b6-9cb8-e5e156f1915a`.
- `_leosanches448`: criação `6a8c63194122b9fbdc6f73b9` confirmada remotamente como publicada e reconciliada localmente para `published`, sem nova postagem.
- 9 criações confirmadas remotamente como `failed` foram marcadas `ignored` com evento de auditoria.
- 5 resultados desconhecidos sem `creation_id` foram pesquisados por conta, horário e mídia; nenhum match remoto foi encontrado, então foram marcados `ignored` com evento de auditoria.
- Estado verificado após a reconciliação: 6.755 `waiting`, 2.170 `published`, 339 `ignored` e zero `failed`.

## Entrega resiliente de mídia Zernio

Em 24/08/2026, a esteira passou a preparar o arquivo na hospedagem de mídia da
Zernio dentro da janela móvel de 24 horas, sem criar ou agendar post remoto.

- migrations `273`, `274` e `275` persistem uma única mídia preparada por
  organização/arquivo, com lease, validade e metadados da sonda;
- a sonda de vídeo sempre executa `GET Range` no início e no fim do arquivo;
- itens já agendados entram na mesma preparação e arquivos repetidos são
  compartilhados entre os perfis;
- até quatro arquivos distintos são transferidos em paralelo e falhas de rede
  transitórias recebem até três tentativas antes de bloquear a preparação;
- itens que compartilham mídia já pronta são promovidos em páginas
  transacionais, sem milhares de leituras externas repetidas;
- falha confirmada de download pode renovar a mídia, atualizar o mesmo
  `postId` e chamar o retry oficial uma única vez dentro de dez minutos;
- `creation_id` nunca é limpo nesse fluxo e nenhuma segunda criação é enviada;
- classificadores de desconexão Zernio e Meta permanecem inalterados.

Validação e produção:

- 32 testes do dispatcher aprovados, incluindo 1.000 itens simultâneos com uma
  única preparação de arquivo;
- TypeScript e build Next.js aprovados;
- migrations `273`, `274` e `275` aplicadas no Supabase remoto;
- worker `athena-publication-worker` reiniciado isoladamente e online;
- janela inicial concluída com 16.623 itens ativos prontos, zero pendente, zero
  preparando, zero bloqueado e 522 mídias compartilhadas hospedadas;
- hash implantado do dispatcher:
  `0db459b760ab504a4860fff01275fb71d39d5c4b3c7c566b3733cf5246694a16`;
- backup remoto mais recente:
  `/opt/athena-worker/scripts/workers/publication-direct-dispatch.mjs.backup-20260825T0305Z`.

## Reversão da hospedagem antecipada — 27/08/2026

A preparação local de 24 horas foi preservada, mas a hospedagem antecipada e o
cache compartilhado de mídia na Zernio foram retirados do caminho ativo. O
compartilhamento da mesma URL física entre publicações provocou recusas de
conteúdo duplicado e acrescentar um parâmetro à URL não alterou a identidade
considerada pelo provedor.

- preparação valida perfil, conexão, formato, mídia e capa somente no banco;
- nenhum byte é lido ou transferido durante a preparação;
- no despacho, uma URL assinada fresca do Supabase é sondada e enviada direto à Zernio;
- `zernio_prepared_media` e as RPCs das migrations 273–275 permanecem apenas
  como legado inativo durante o rollout, sem remoção destrutiva;
- falha de download renova a URL no mesmo `postId`, sem segunda criação;
- itens com `creation_id` continuam elegíveis à reconciliação em lote pausado;
- duplicidade explícita fica isolada no item e não alimenta o circuit breaker do lote.
