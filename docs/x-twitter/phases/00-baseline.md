# Fase 00 — baseline e congelamento

Status: `completed`

## Objetivo

Transformar o estado preexistente de Analytics em checkpoint reproduzível antes de criar qualquer código X.

## Escopo

- inventário Git;
- alinhamento Supabase 001–222;
- baseline local e VPS;
- documentação de continuidade;
- correção não destrutiva dos globs inválidos do `.gitignore`;
- commit de checkpoint em branch separada.

## Fora do escopo

- migration X;
- deploy Vercel;
- restart PM2;
- publicação Zernio;
- limpeza de artefatos desconhecidos.

## Evidência inicial

- Branch: `codex/pre-x-baseline-analytics`
- Commit: `1caa0f2e5cb0773982f41cfcddb9bcdf9a45d9cb`
- Supabase: projeto ref `hqwhumdumfmixxbvneae`, migrations 001–222 alinhadas.
- Vercel: projeto `pomodoro` vinculado.
- VPS: `srv1881733`; seis workers Instagram online no preflight; sem processos X.
- Local: Node 22.19.0; npm 11.6.0.
- VPS: Node 22.23.2, disco e RAM saudáveis, sem swap.

## Validações

- [x] Revisão estrutural do diff Analytics existente
- [x] `npm test` — 137/137
- [x] `npx tsc --noEmit`
- [x] `npm run build`
- [x] `npx supabase migration list --linked`
- [x] acesso Vercel confirmado
- [x] acesso SSH/PM2 confirmado
- [x] `rg` volta a ler o repositório sem erro de `.gitignore`
- [x] `git diff --check`
- [x] commit do gate — `41fd0c2414a46672210487e0dcee25ecc17aed82`

## Rollback

Não há mutação remota nesta fase. Um rollback deve reverter somente o commit de checkpoint; nunca reaplicar ou apagar migrations 210–222.

## Próximo passo

Abrir a branch isolada `codex/x-twitter-module` e iniciar a fundação local.
