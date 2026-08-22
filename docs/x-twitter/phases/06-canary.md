# Fase 06 — canário de publicação

Status: `in_progress` — pausado por solicitação do usuário antes do provisionamento

Ordem: texto, uma imagem, 2–4 imagens, GIF, vídeo e URL. Gate: publicação, ledger, reservas, logs e regressão Instagram aprovados.

Preparação concluída em 2026-08-22: adaptador `POST /v1/posts`, mídia assinada, credencial cifrada até o worker, classificação financeira e webhook HMAC/deduplicado. Testes Node 161/161 e SQL 233 7/7. Migrations remotas até 234.

Checkpoint 2026-08-22T19:27:10Z: a organização canário é Pomodoro. A credencial dedicada foi validada somente em memória; `/v1/auth/verify` confirmou identidade estável, e o inventário confirmou exatamente um profile Zernio com exatamente uma conta Twitter e nenhuma conta de outra plataforma. O tier não veio no payload Zernio; usar o fallback Free/280 confirmado pelo usuário. Não houve chamada de post, analytics ou billing.

O código local pendente passa a adotar o profile existente somente quando há exatamente um profile e todo o inventário dele é Twitter. Isso evita criar um profile vazio e exigir reconexão, sem enfraquecer o isolamento. Alterações ainda não commitadas em `app/x/twitter-zernio-client.tsx`, `lib/twitter/zernio-client.ts`, `lib/twitter/zernio-connections.ts` e `lib/twitter/zernio-client.test.ts`; 164/164 testes, TypeScript e build aprovados. `git diff --check` aprovado.

A chave foi cifrada/persistida no Supabase e o profile existente foi sincronizado em 2026-08-22T19:40:21Z. Estado confirmado: uma conta ativa, `can_post=true`, token válido, identidade X imutável, limite efetivo 280, grant único de 12.000.000 micros, reservado zero, um único ledger grant e zero débitos. `analytics=false` e `inbox=false`. Os cinco workers X continuam parados; nenhuma publicação ocorreu.

O primeiro utilitário de provisionamento parou após as RPCs porque esperava `id`, enquanto a RPC retorna `connectionId`. A inspeção read-only confirmou estado parcial íntegro; o leitor foi corrigido em `50469d4`. A repetição idempotente não criou outro grant e concluiu a sincronização. Próximo gate: deploy do código atual ainda com flags globais off e criação de um único item texto sem URL por review/confirm.

Deploy atual concluído com flags globais off: Preview `dpl_4QkYfwXxWeYu4TY7EixwfVJUFrJf` e Production `dpl_DiBtbGFbYLsNpEA5GpMCWNbLN5W7`, ambos `READY`. Smoke em ambos: login 200, `/x/zernio` sem sessão 307 e heartbeat POST sem segredo 401. O GET do heartbeat retorna 405 por método, como esperado. Nenhum worker foi iniciado.

Primeiro item preparado para 2026-08-22T20:05:00Z: programa `1d3d9013-4cf6-484e-8596-4552c1623636`, item `e5388d6a-82ce-45e7-81a3-27b37adc643b`. Um slot financiado, zero excedente, categoria `post_dm_create`, 15.000 micros reservados, zero tentativas. Carteira: 12.000.000 contábil, 15.000 reservado, versão 2. Flags live ainda off e workers parados.
