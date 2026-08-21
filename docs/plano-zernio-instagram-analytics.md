# Plano de correção dos detalhes de perfil Instagram via Zernio

## Auditoria da documentação consultada

Fontes consultadas antes das alterações:

- `https://docs.zernio.com/platforms/instagram`
- `https://docs.zernio.com/llms.txt`
- `https://docs.zernio.com/llms-full.txt`
- `https://docs.zernio.com/analytics/get-analytics.mdx`
- `https://docs.zernio.com/analytics/get-instagram-account-insights.mdx`
- `https://docs.zernio.com/analytics/get-instagram-follower-history.mdx`
- `https://docs.zernio.com/accounts/get-follower-stats.mdx`
- `https://docs.zernio.com/analytics/get-instagram-demographics.mdx`
- `https://docs.zernio.com/analytics/get-daily-metrics.mdx`
- `https://docs.zernio.com/analytics/get-best-time-to-post.mdx`
- `https://docs.zernio.com/analytics/get-content-decay.mdx`
- `https://docs.zernio.com/messages/list-inbox-conversations.mdx`
- `https://docs.zernio.com/inbox-analytics/get-inbox-volume.mdx`

## Matriz de campos

| Campo na tela | Endpoint Zernio | Caminho no payload | Persistência local | Status |
|---|---|---|---|---|
| Seguidores atuais | `GET /v1/analytics/instagram/follower-history` | `metrics.follower_count.values[].value`; fallback `metrics.follower_count.total` | `profile_analytics_snapshots.followers_count` e `profile_follower_daily_snapshots.followers_count` | Implementado |
| Total atual ao vivo da página | `GET /v1/accounts` | `accounts[].followersCount` / variações em `profileData` quando disponíveis | `profile_analytics_snapshots.followers_count` e `raw_payload.liveFollowers` | Implementado como prioridade sobre período |
| Ganhos/perdas de seguidores | `GET /v1/analytics/instagram/follower-history` | `metrics.followers_gained` e `metrics.followers_lost` | `profile_analytics_snapshots.followers_gained`, `followers_lost`, `profile_follower_daily_snapshots` | Implementado |
| Fallback geral de seguidores | `GET /v1/accounts/follower-stats` | `accounts`/`stats` conforme conta | `profile_analytics_snapshots.raw_payload.followerStatsFallback` | Coletado como diagnóstico |
| Alcance, views, interações, links | `GET /v1/analytics/instagram/account-insights` | `metrics.<metric>.total` | `profile_analytics_snapshots` | Implementado |
| Posts e métricas por post | `GET /v1/analytics` | `posts[].platformAnalytics[].analytics` | `profile_post_analytics_snapshots` | Implementado |
| Postagens atuais da página | `GET /v1/posts?source=external&status=published` | `posts[]` | `profile_post_analytics_snapshots` com métricas zeradas quando não houver analytics | Implementado |
| Métricas diárias | `GET /v1/analytics/daily-metrics` | Payload agregado da Zernio | `profile_analytics_snapshots.raw_payload.dailyMetrics` | Coletado no bruto |
| Melhor horário | `GET /v1/analytics/best-time` | Payload agregado da Zernio | `profile_analytics_snapshots.raw_payload.bestTime` | Coletado no bruto |
| Decaimento de conteúdo | `GET /v1/analytics/content-decay` | Payload agregado da Zernio | `profile_analytics_snapshots.raw_payload.contentDecay` | Coletado no bruto |
| Demografia | `GET /v1/analytics/instagram/demographics` | `demographics.age/city/country/gender` | `profile_analytics_snapshots.raw_payload.demographics` | Coletado no bruto; exige 100+ seguidores |
| Inbox | `GET /v1/inbox/conversations` e `GET /v1/analytics/inbox/*` | Conversas e agregados de inbox | Não persistido nesta fase | Remover placeholders falsos até haver produto de inbox |

## Decisão de UI

- Não mostrar cards zerados de inbox como se fossem métricas reais.
- Manter diagnóstico bruto com payloads por chamada e endpoint consultado.
- Usar `raw_payload` para dados recém-mapeados nesta fase, sem criar tabela precipitada para formatos que a Zernio pode evoluir.
- Criar migração estrutural só depois de validar em produção o formato real de `dailyMetrics`, `bestTime`, `contentDecay`, `demographics` e inbox analytics.

