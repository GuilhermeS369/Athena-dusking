# Fase 06 — canário de publicação

Status: `blocked`

Ordem: texto, uma imagem, 2–4 imagens, GIF, vídeo e URL. Gate: publicação, ledger, reservas, logs e regressão Instagram aprovados.

Preparação concluída em 2026-08-22: adaptador `POST /v1/posts`, mídia assinada, credencial cifrada até o worker, classificação financeira e webhook HMAC/deduplicado. Testes Node 161/161 e SQL 233 7/7. Migrations remotas até 234.

O gate real não foi executado: não existe credencial X/Zernio dedicada cadastrada por admin. Não reutilizar credenciais Instagram. Flags e `TWITTER_PUBLICATION_MODE=shadow` permanecem desligados.
