# Fase 06 — canário de publicação

Status: `in_progress` — seis canários positivos e cancelamento aprovados; cenários controlados de erro pendentes

Ordem: texto, uma imagem, 2–4 imagens, GIF, vídeo e URL. Gate: publicação, ledger, reservas, logs e regressão Instagram aprovados.

Preparação concluída em 2026-08-22: adaptador `POST /v1/posts`, mídia assinada, credencial cifrada até o worker, classificação financeira e webhook HMAC/deduplicado. Testes Node 161/161 e SQL 233 7/7. Migrations remotas até 234.

Checkpoint 2026-08-22T19:27:10Z: a organização canário é Pomodoro. A credencial dedicada foi validada somente em memória; `/v1/auth/verify` confirmou identidade estável, e o inventário confirmou exatamente um profile Zernio com exatamente uma conta Twitter e nenhuma conta de outra plataforma. O tier não veio no payload Zernio; usar o fallback Free/280 confirmado pelo usuário. Não houve chamada de post, analytics ou billing.

O código local pendente passa a adotar o profile existente somente quando há exatamente um profile e todo o inventário dele é Twitter. Isso evita criar um profile vazio e exigir reconexão, sem enfraquecer o isolamento. Alterações ainda não commitadas em `app/x/twitter-zernio-client.tsx`, `lib/twitter/zernio-client.ts`, `lib/twitter/zernio-connections.ts` e `lib/twitter/zernio-client.test.ts`; 164/164 testes, TypeScript e build aprovados. `git diff --check` aprovado.

A chave foi cifrada/persistida no Supabase e o profile existente foi sincronizado em 2026-08-22T19:40:21Z. Estado confirmado: uma conta ativa, `can_post=true`, token válido, identidade X imutável, limite efetivo 280, grant único de 12.000.000 micros, reservado zero, um único ledger grant e zero débitos. `analytics=false` e `inbox=false`. Os cinco workers X continuam parados; nenhuma publicação ocorreu.

O primeiro utilitário de provisionamento parou após as RPCs porque esperava `id`, enquanto a RPC retorna `connectionId`. A inspeção read-only confirmou estado parcial íntegro; o leitor foi corrigido em `50469d4`. A repetição idempotente não criou outro grant e concluiu a sincronização. Próximo gate: deploy do código atual ainda com flags globais off e criação de um único item texto sem URL por review/confirm.

Deploy atual concluído com flags globais off: Preview `dpl_4QkYfwXxWeYu4TY7EixwfVJUFrJf` e Production `dpl_DiBtbGFbYLsNpEA5GpMCWNbLN5W7`, ambos `READY`. Smoke em ambos: login 200, `/x/zernio` sem sessão 307 e heartbeat POST sem segredo 401. O GET do heartbeat retorna 405 por método, como esperado. Nenhum worker foi iniciado.

Primeiro item preparado para 2026-08-22T20:05:00Z: programa `1d3d9013-4cf6-484e-8596-4552c1623636`, item `e5388d6a-82ce-45e7-81a3-27b37adc643b`. Um slot financiado, zero excedente, categoria `post_dm_create`, 15.000 micros reservados, zero tentativas. Carteira: 12.000.000 contábil, 15.000 reservado, versão 2. Flags live ainda off e workers parados.

Gate texto sem URL aprovado às 2026-08-22T20:05:06Z. Uma tentativa, HTTP 201, provider `published`, post ID persistido. Reserva/hold liquidados em 15.000 micros; ledger contém exatamente grant + débito de -15.000; wallet 11.985.000 contábil, reservado zero, versão 3. Zero itens não terminais. Logs imutáveis `external_started` e `published`; nenhuma leitura paga adicional foi feita. Worker parado e flags restauradas para `false`/`shadow`; Production segura `dpl_619TNoqFWYVMDYxj33dc9BfcWBoG`.

Canário de uma imagem preparado: asset `6b844cdc-9285-4c9d-aef1-b5403cb794e6`, PNG 1200×675, 33.019 bytes, SHA-256 `6c4b088351e0f0b7488941a7a2ae82b71d8905f61083cbad2e05e2067bbc8122`, status `ready` e leitura assinada verificada. Programa `d309ee0e-1a86-4df5-a840-49edec50ba32`, item `66542b07-7e55-47f8-aaca-0075b98171db`, execução 2026-08-22T20:19:00Z. Um conjunto `images`, um asset na posição 0, custo/reserva 15.000, zero tentativas. Live off e workers parados.

Gate de uma imagem aprovado às 2026-08-22T20:19:10Z. Uma tentativa, HTTP 201, provider `published`; reserva e hold `settled` em 15.000. Wallet 11.970.000, reservado zero, versão 5; ledger agora contém grant + dois débitos exatos de 15.000. Logs `external_started`/`published`, zero itens não terminais. Worker parado e Production novamente `false`/`shadow` em `dpl_ESxPGApRWS7ssj9j796PGCMZUabG`.

Canário 2 imagens preparado: novo asset `bf7678c6-6e5b-4a10-8860-75de6642afe2`, PNG 1200×675, 32.587 bytes, hash `439012493da8b046b30a11671c01cab0b155d4c8358f29006e87187f8e4751bb`. Programa `fd765ce3-ce69-451c-9423-62479414f545`, item `25a8be0e-10ea-4937-9d7f-031dbfcfee2f`, execução 20:31Z. Set `images` com assets nas posições 0 e 1, reserva 15.000, tentativa 0, live off.

Gate 2 imagens aprovado: uma tentativa HTTP 201, `published`; wallet 11.955.000/0, versão 7; ledger grant + três débitos de 15.000. Reserva/hold liquidados, logs completos e zero não terminais. Worker parado e Production desabilitada `dpl_58q7bZmjMqCBrqDS9kFWc4UkZYrz`.

GIF preparado: asset `7dea1898-89e8-4222-9183-3a3a38c7fdaa`, 640×360, 2s, 316.445 bytes, SHA-256 `8025a9a8a5de9e094513c314eef1d7cb38d8d7f2c09ac2d85dbf3ee036ddfccb`, leitura assinada aprovada. Programa `cd71cc46-ec4b-4209-86b3-436ee2ebf44a`, item `582c0a4f-7c65-4921-893b-661867ac518b`, execução 20:44Z; 15.000 reservado, tentativa 0, live off.

Gate GIF aprovado: uma tentativa HTTP 201 `published`; wallet 11.940.000/0, versão 9; grant + quatro débitos de 15.000; reserva/hold settled e zero não terminais. Worker parado e Production segura `dpl_C1N6yohwYnJb96XmSi5D5KEviBQs`.

Vídeo preparado: asset `3648930e-a2d1-4535-b248-6d7b3f9cccaf`, MP4 640×360, 2s, 116.645 bytes, hash `19bd78345e308eef3f807acf5a2ce8d49d2e67ba0dbd36d839f552e6229e8992`, signed read ok. Programa `466ff096-82f1-4dd2-a75d-11c124bae815`, item `93358c36-99ee-44d0-90c3-807dd6c9d71e`, execução 20:56Z, reserva 15.000, attempt 0, live off.

Gate vídeo aprovado: uma tentativa HTTP 201 `published`; wallet 11.925.000/0, versão 11; grant + cinco débitos de 15.000; reserva/hold settled e zero não terminais. Worker parado e Production segura `dpl_CxzynkGZo6MEx3J8yjRcXQgxGnG9`.

O primeiro review URL revelou uma instabilidade determinística antes de qualquer mutação: `weighted_characters` alternava porque uma regex global compartilhava `lastIndex` entre contagem e detecção. O fix `31fb1d2` separa regex de match/test, adiciona teste de revisões consecutivas e diagnóstico seguro. Suite 165/165, TypeScript e build aprovados.

Canário URL preparado: programa `97a662b2-d798-43d7-a18f-f4596d71d4d0`, item `884961c8-a3e1-4f97-bcb8-98c3911171f2`, execução 21:22Z, `ready`, zero tentativas e sem mídia. Categoria `post_create_url`, custo/reserva total 200.000 micros; wallet 11.925.000 contábil, 200.000 reservado, versão 12. Nenhuma chamada externa ocorreu; live continua desligado até novo preflight.

Gate URL aprovado: uma tentativa HTTP 201 `published`; hold/chamada 21:22:04Z–21:22:08Z; reserva e hold settled em 200.000. Wallet 11.725.000/0, versão 13; ledger contém grant, cinco débitos sem URL de 15.000 e um débito URL único de 200.000. Zero não terminais. Worker parado, VPS false/shadow e Production segura `dpl_Dcrsn7Ty4dQnRTgcM8kCyyXTD2DF`.

Ordem positiva concluída: texto, uma imagem, duas imagens, GIF, vídeo e URL. O gate da fase ainda exige os cenários controlados de cancelamento, timeout, 429, 4xx, 5xx e duplicidade. Esses testes não devem atingir a Zernio real sem uma injeção determinística que elimine cobrança ambígua.

Cancelamento local aprovado: programa `7c591f5d-c34e-434d-b5fa-4efdd948856b`, item `211d232f-8607-42ae-8607-edba1bbfc275`. A primeira chamada liberou 15.000; repetição idempotente liberou zero. Item/hold/reserva terminaram cancelled/released/released, tentativa 0. Wallet e ledger permaneceram em 11.725.000; nenhum crédito, débito ou chamada externa.
