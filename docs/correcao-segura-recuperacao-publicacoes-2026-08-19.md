# Correção segura da recuperação de publicações — 2026-08-19

## Objetivo

Corrigir a esteira sem alterar horários futuros, mídias, legendas, perfis ou lotes agendados. A mudança separa definitivamente:

1. **slot coletivo que venceu sem iniciar:** não deve ser publicado atrasado;
2. **publicação que já iniciou no provedor:** deve continuar apenas por polling/reconciliação da mesma criação;
3. **falha transitória com rejeição conhecida:** pode receber retry durável com backoff;
4. **criação externa com resultado desconhecido:** não pode criar uma segunda postagem automaticamente.

## Incidente e riscos identificados

### Regressão no claim de falhas terminais

A migration 100 exigia `next_attempt_at` para recolocar um item `failed` no claim. A migration 110 redefiniu o RPC e removeu essa exigência. Com isso, falhas terminais com menos de cinco tentativas podiam voltar à esteira mesmo sem retry agendado.

### Resultado desconhecido na criação Zernio

Uma interrupção de rede ou timeout no `POST /v1/posts` não prova que a Zernio rejeitou a postagem. Como o post é criado com `publishNow`, repetir a criação sem reconciliação pode duplicar conteúdo caso a primeira solicitação tenha sido aceita e somente a resposta tenha sido perdida.

### Segunda criação na recuperação de download

O fluxo de recuperação de mídia gerava uma nova chave externa com sufixo `-recovery-1`. Essa segunda operação não era deduplicada contra a primeira criação. Se a primeira criação terminasse tardiamente, ambas poderiam publicar.

### Slots coletivos vencidos presos em `at_risk`

O fluxo atual bloqueia corretamente o claim normal, mas mantém o slot aguardando uma recuperação coordenada. A política aprovada é terminal: se o slot venceu sem criação externa, ele deve ser ignorado com auditoria, sem deslocamento e sem publicação tardia.

## Invariantes obrigatórios

- Nenhum item com `execute_at` futuro pode ser atualizado pela correção de slots vencidos.
- Nenhum `execute_at`, mídia, legenda, perfil, lote ou horizonte futuro será reescrito.
- Item com `creation_id` nunca será descartado pela expiração do slot; ele continuará consultando a mesma criação.
- Falha terminal sem `next_attempt_at` nunca volta ao claim.
- Retry só ocorre quando foi explicitamente agendado.
- Timeout/erro de transporte durante criação Zernio, sem `creation_id`, termina em atenção operacional e não recria automaticamente.
- A recuperação automática que usa uma segunda chave Zernio fica desabilitada.
- O próximo slot coletivo permanece intacto.
- Itens já `published`, `ignored`, `removed`, `cancelled` ou `suspended` não são reabertos.

## Implementação

### Banco

Uma migration aditiva redefine os RPCs, sem editar migrations antigas:

- `claim_publication_items`: restaura a exigência de `next_attempt_at` para falhas e permite polling de itens com `creation_id` mesmo quando o slot correspondente está em risco;
- `recover_missed_publication_slots`: encerra somente itens `bulk:*` vencidos, ainda em `waiting/ready`, sem `creation_id` e sem lease válido; não reage agenda futura;
- `claim_publication_slot_recovery_items`: permanece como RPC compatível, mas retorna vazio para impedir publicação tardia inclusive durante rollout com worker antigo;
- `schedule_zernio_media_download_recovery`: permanece compatível, mas não limpa `creation_id` nem agenda uma criação substituta;
- o incidente correspondente é resolvido como `ignored` somente quando não restarem itens não iniciados do slot aguardando decisão;
- a quarentena legada foi preparada de forma idempotente e auditável; o preflight encontrou zero itens que satisfaziam a condição, portanto nenhum item real foi alterado por ela.

### Worker

- criação Zernio com erro de transporte/timeout e sem resposta HTTP vira `zernio_creation_outcome_unknown`, terminal e auditável;
- HTTP 5xx durante criação também é tratado como resultado desconhecido; HTTP 429 continua retryable por representar rejeição explícita;
- polling Zernio com `creation_id` mantém retry transitório e nunca cria outro post;
- item legado com `zernio_recovery_count > 0` e sem `creation_id` não inicia criação substituta;
- falha de download continua recebendo a segunda consulta do post original, mas não agenda uma segunda criação.

## Implantação e evidências

### Validação local

- `node --check` do dispatcher: aprovado;
- testes do dispatcher: 22 de 22 aprovados, incluindo timeout, HTTP 5xx, HTTP 429, polling existente e bloqueio legado;
- `npx tsc --noEmit`: aprovado;
- build Next.js de produção: aprovado; permaneceram apenas os avisos preexistentes de metadata `viewport`/`themeColor`;
- dry-run do Supabase confirmou que somente a migration 195 seria aplicada.

### Preflight do banco

- 19.517 itens futuros ativos observados no corte inicial;
- 8 incidentes `at_risk` observados;
- 19 itens ativos com `creation_id`, preservados para polling/reconciliação;
- zero itens com `zernio_recovery_count > 0`, sem `creation_id` e em estado alcançável pela quarentena;
- snapshot fixo de 29.692 horários futuros e 8.805 pares com `creation_id` registrado antes da aplicação.

### Supabase em produção

- migration 195 aplicada com sucesso e histórico local/remoto alinhado;
- o teste SQL via `supabase db test --linked` não pôde ser executado porque a versão instalada do CLI exige Docker até para esse caminho remoto; a indisponibilidade foi registrada, sem mascarar como sucesso;
- validação equivalente via PostgREST confirmou retorno vazio do claim coordenado;
- os hashes do snapshot fixo antes/depois permaneceram idênticos:
  - horários futuros: `aee956deea7fc4cca8a3eed088a674454078fb59b7b0e963b326e3f80a7bb85c`;
  - pares com `creation_id`: `ad7bc356c67bc52d8929371336d815373dc3f3a93c6f911f4c66906008372537`;
- contagens antes/depois também permaneceram em 29.692 horários e 8.805 criações;
- zero itens foram retornados pelo claim coordenado e zero candidatos legados permaneceram.

### VPS

- dispatcher enviado isoladamente, sem alterar variáveis de ambiente ou outros workers;
- hash implantado: `d3934b4a991e9c00e2df4a0c3e22864056efe6e53df67517b45e633dcc690f88`;
- backup remoto: `/opt/athena-worker/scripts/workers/publication-direct-dispatch.mjs.backup-20260819T0241Z`;
- hash do backup: `ef61704a14a518299e34da3e4b2b299e89cbbb89ebc8fdb2833b7d9688240f43`;
- `node --check` remoto aprovado antes e depois da instalação;
- somente `athena-publication-worker` foi reiniciado; o estado PM2 foi salvo e os cinco processos permaneceram online;
- heartbeat pós-deploy: `dispatching`, `dry_run=false`, modo `direct`, sem erro;
- ciclos pós-deploy concluídos em aproximadamente 300–364 ms, sem `error_code`, leases expirados ou itens overdue;
- recovery coordenado registrou `claimed=0` e `finalized=0`, conforme a nova política.

Os erros de telemetria Zernio por `operation` nula visíveis no arquivo de erro são preexistentes ao deploy e não bloqueiam a fila. Eles não foram incluídos nesta correção para evitar ampliar o escopo operacional.

## Validação mínima antes do deploy

1. Testes unitários do classificador de erro da criação Zernio.
2. Teste de bloqueio da recriação automática.
3. Teste SQL de contrato dos RPCs redefinidos.
4. Verificação sintática dos workers.
5. TypeScript e build do Next.js.
6. Auditoria do diff.
7. Aplicação da migration no Supabase.
8. Consulta somente leitura confirmando ausência de alteração em itens futuros.
9. Deploy do worker com backup e rollback preparado.

## Rollback

- Worker: restaurar o diretório/pacote anterior da VPS e reiniciar o processo PM2.
- Banco: não reabrir itens terminalmente ignorados. Se for necessário reverter apenas o comportamento futuro, aplicar nova migration restaurando os RPCs anteriores; nunca apagar histórico nem transformar itens ignorados em aguardando.
- Vercel: a alteração principal do runtime está no worker direto da VPS. Mudanças de documentação/testes não afetam execução; qualquer mudança compartilhada deve passar pelo build antes do deploy normal da aplicação.

## Fora de escopo deliberado

- Republicar itens antigos.
- Reagendar itens vencidos.
- Alterar horários futuros.
- Fazer limpeza destrutiva de eventos.
- Aumentar concorrência ou limites como compensação para o incidente.
