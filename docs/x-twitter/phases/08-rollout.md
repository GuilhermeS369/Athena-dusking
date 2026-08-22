# Fase 08 — rollout e handoff

Status: `blocked`

Entregas: ativação progressiva, fallback validado, monitoramento, comparação Instagram e handoff final. Gate: módulo independente, observável e reversível.

## Checkpoint de segurança anterior ao preview

- Migration 240 aplicada de forma aditiva e alinhada no remoto.
- Remoção de conexão agora libera somente holds que nunca iniciaram; holds ativos ou incertos permanecem para reconciliação.
- Leases expirados de analytics passam para `outcome_unknown`, sem retry cego.
- Os cinco workers consultam circuit breaker persistente próprio e registram sucesso/falha.
- Regras financeiras futuras possuem gestão somente por admin, combinação exata, eventos imutáveis e desativação sem exclusão.
- Teste SQL 240: 13/13 em transação com rollback; nenhum resíduo.
- Regressão: 163/163 testes, TypeScript e build aprovados; warnings metadata preexistentes permanecem fora do escopo.
- Commit de código: `1a74e4afd77f166674b05d43647d5abb1951bb38`.

Próximo gate: preview Vercel com todas as flags X desligadas e smoke test. Não promover para produção nem executar canário sem credencial X dedicada.

## Deploy desabilitado e instalação operacional

- Preview final: `dpl_2JSe1hjSEdWCCVZH9VJ96zC7QXua`, estado `READY`.
- Produção final: `dpl_Akd9xnWZxrfeZpz9XpvsA5JgZgAR`, estado `READY`, alias `https://pomodoro-theta-one-82.vercel.app`.
- Rollback Vercel anterior: `dpl_DuXLdmBjjofPwJEsCNSSf6b5D39J` / `https://pomodoro-mwify00nv-shoows-projects-2caaf9e9.vercel.app`.
- Flags Production e Preview: módulo, publicação e analytics explicitamente desligados; modo de publicação `shadow`.
- Segredos exclusivos X foram configurados em Vercel e VPS sem registrar valores.
- Release VPS: `/opt/athena-twitter/releases/3f3821171839-20260822T184649Z`.
- SHA-256 do pacote: `9aaf4f732665bf3b853c2296646abe9f4a21f2a113f12de4dfd3621c7b87cb33`.
- Artefato local ignorado: `artifacts/x-twitter/20260822T184649Z/athena-twitter-worker.tar.gz`.
- Config compartilhada: `/opt/athena-twitter/shared/.env.worker`, permissão `600`.
- Os cinco processos `athena-twitter-*` estão instalados e persistidos no PM2 em estado `stopped`.
- One-shot final dos cinco papéis contra produção: aprovado; heartbeats `stopped`; zero claims, zero analytics em processamento e zero resolução financeira.
- Os seis processos existentes permaneceram `online` com os mesmos PIDs observados antes da instalação.

## Smoke e desvios registrados

- Login produção `200`; páginas autenticadas Instagram e X redirecionam visitante sem sessão com `307`; heartbeat sem segredo retorna `401`.
- A primeira execução remota do pacote falhou antes da rede porque usou `cwd=/root`; foi repetida do release correto e aprovada.
- O primeiro teste de pareamento Production retornou `401` antes de claim; o segredo foi rotacionado atomicamente, redeployado e o teste final dos cinco papéis passou após propagação.
- Nenhuma API Zernio foi chamada, nenhum post foi criado e nenhuma reserva foi materializada durante o rollout desabilitado.

## Bloqueio do gate

Fases 6 e 8 não podem ser concluídas sem uma organização canário escolhida e uma API key Zernio dedicada a uma identidade X, cadastrada por admin. É proibido reutilizar credencial do Instagram. Até essa entrada existir, não habilitar flags, não iniciar workers e não configurar fallback Vercel.

Próxima ação segura: informar o ID da organização canário; configurar somente `TWITTER_CANARY_ORGANIZATION_IDS`; um admin cadastra a chave na página X/Zernio; então executar o canário na ordem documentada antes de qualquer rollout.
