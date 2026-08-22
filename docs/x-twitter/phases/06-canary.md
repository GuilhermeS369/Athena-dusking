# Fase 06 — canário de publicação

Status: `in_progress` — pausado por solicitação do usuário antes do provisionamento

Ordem: texto, uma imagem, 2–4 imagens, GIF, vídeo e URL. Gate: publicação, ledger, reservas, logs e regressão Instagram aprovados.

Preparação concluída em 2026-08-22: adaptador `POST /v1/posts`, mídia assinada, credencial cifrada até o worker, classificação financeira e webhook HMAC/deduplicado. Testes Node 161/161 e SQL 233 7/7. Migrations remotas até 234.

Checkpoint 2026-08-22T19:27:10Z: a organização canário é Pomodoro. A credencial dedicada foi validada somente em memória; `/v1/auth/verify` confirmou identidade estável, e o inventário confirmou exatamente um profile Zernio com exatamente uma conta Twitter e nenhuma conta de outra plataforma. O tier não veio no payload Zernio; usar o fallback Free/280 confirmado pelo usuário. Não houve chamada de post, analytics ou billing.

O código local pendente passa a adotar o profile existente somente quando há exatamente um profile e todo o inventário dele é Twitter. Isso evita criar um profile vazio e exigir reconexão, sem enfraquecer o isolamento. Alterações ainda não commitadas em `app/x/twitter-zernio-client.tsx`, `lib/twitter/zernio-client.ts`, `lib/twitter/zernio-connections.ts` e `lib/twitter/zernio-client.test.ts`; 164/164 testes, TypeScript e build aprovados. `git diff --check` aprovado.

A chave ainda não foi cifrada/persistida no Supabase, a conexão/perfil ainda não foi sincronizada localmente e nenhum grant/reserva/débito foi criado. Os cinco workers X continuam parados; nenhuma publicação ocorreu. Antes de continuar, commitar o checkpoint, provisionar pela rotina transacional, forçar `analytics=false` e `inbox=false`, e verificar carteira inicial de 12.000.000 micros sem reservas/débitos.
