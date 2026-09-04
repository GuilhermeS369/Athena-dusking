# Migração para a API da Meta — prontidão do lado da fila

**Escrito em 04/09/2026**, durante a suspensão em massa das contas Zernio.
Cobre **tudo menos o cliente da API**, que está sendo feito em paralelo.

A mudança de topologia é o ponto: sai **uma credencial por conta** (2.166 chaves
Zernio) e entra **um app da Meta para ~100 perfis** (`meta_apps.instagram_slot_limit`
= 100, migration 366). Com ~3.300 perfis, isso são ~33 credenciais em vez de
milhares. Quase tudo melhora com isso. Duas coisas quebram.

---

## O que JÁ está pronto, e é mais do que parece

### O programar em massa é agnóstico de provedor

Verificado: `lib/publications/bulk-rotation.ts`, `bulk-api.ts` e
`bulk-plan-grouping.ts` **não mencionam `provider` nem `zernio` uma única vez**.
Planos de rotação, agrupamento, slots, horizonte, geração incremental — nada
disso sabe qual provedor publica. Continua funcionando sem tocar em uma linha.

### O modelo de dados já é multi-provedor desde a migration 053

- `instagram_integration_provider` é enum `('meta_official', 'zernio')`, e
  `meta_official` é o **valor padrão** da coluna.
- `publication_dispatch_rate_reservations.provider` já aceita `'meta_official'`.
- `publication_rate_limit_settings.provider` também.
- **14 perfis já rodam em `meta_official` hoje**, contra 3.293 em `zernio`. O
  caminho não está frio: está em produção, só que pequeno.

### O fatiamento do lock (migration 360) é agnóstico

O lock é `(organização, provedor, balde do hash do perfil)`. Ele passa a valer
para `meta_official` sem alteração nenhuma, e o balde por perfil continua
distribuindo bem. Ver seção 3-B de
[fila-de-publicacao-mapa-de-controles.md](fila-de-publicacao-mapa-de-controles.md).

### O limite por perfil já bate com o limite real da Meta

`max_profile_publications_per_24h` está em **100**, que é exatamente o teto de
publicações por conta do Instagram em 24 h da API de conteúdo. Coincidência
feliz, mas confere.

### O que é mesmo específico da Zernio no despacho é estreito

Só dois pontos em `lib/publications/dispatcher.ts`: a chamada ao publicador
(linha 403) e o gancho que agenda reciclagem de perfil quando a publicação falha
(linhas 423-433, `schedule_zernio_profile_disconnection`). O resto do caminho é
comum.

---

## ~~BLOQUEADOR 1~~ — RESOLVIDO em 04/09 (migration 369)

> Linha `meta_official` criada com teto de 1200/min. Verificado replicando a
> ordenação real da função: `meta_official` agora resolve na própria linha, nas
> três organizações, e o `zernio` segue na dele. O texto abaixo fica como
> registro do que estava errado.

### O que estava errado

**Este é o mais grave e o mais barato de corrigir.**

Hoje existem exatamente duas linhas em `publication_rate_limit_settings`:

| escopo | `max_provider_publications_per_minute` |
|---|---:|
| GLOBAL / `*` | **50** |
| GLOBAL / `zernio` | **1200** |

**Não existe linha para `meta_official`.** A busca de configuração em
`reserve_publication_dispatch_capacity` ordena por especificidade e cai na linha
mais genérica que casar. Para `provider = 'meta_official'` a linha do `zernio`
não casa (o provedor é diferente e não é nulo), então ele cai no `*` — **50 por
minuto**, contra os 1200 de hoje.

E 50 não significa 50 publicações por minuto. O teto é comparado contra
publicados no último minuto **mais as reservas ativas**, e o mapa de controles
mede que cada publicação/minuto custa ~4 unidades por causa dos itens em voo.
Na prática o teto de 50 entrega algo em torno de **12 publicações por minuto**.
A frota faz ~3.000/hora hoje.

**Correção:** inserir a linha `meta_official` com o teto adequado, antes de
virar qualquer perfil. É um `INSERT`. O que não pode é virar e descobrir depois.

---

## ~~BLOQUEADOR 2~~ — RESOLVIDO em 04/09 (migration 372)

> Cota por app implementada, **aditiva** à da organização, com o lock passando a
> ser por app quando há app — porque contar por app dentro do lock por hash de
> perfil reintroduziria a corrida. O teto nasce **nulo** de propósito: o limite
> real da Meta é dinâmico (`X-App-Usage`) e não há número publicado para cravar.
> Com nulo, o comportamento é idêntico ao anterior; a alavanca fica pronta.
> Ativar: `update public.meta_apps set max_publications_per_minute = N`.
>
> Perfis legados com `meta_app_id` nulo seguem no balde por perfil e na cota da
> organização, conforme combinado com a sessão da migração.

### O que estava errado

Este é o de projeto, não de configuração.

A Zernio limitava **por conta** (25 posts/hora por conta, pico medido de 4). Com
milhares de chaves, uma cota agregada por organização era uma aproximação boa o
bastante — nenhuma chave individual chegava perto do próprio limite.

Com a Meta isso inverte: **o limite é do app**, e 100 perfis dividem o mesmo
app. O app vira o recurso escasso, e é exatamente o que o sistema não sabe
contar.

O que existe hoje:

- `publication_dispatch_rate_reservations` tem `(organization_id, profile_id,
  provider)` e **nenhuma coluna de app**;
- o teto por minuto é contado por `(organização, provedor)` — **um número só
  para todos os apps somados**;
- `reserve_publication_dispatch_capacity` não menciona `meta_app` em lugar
  nenhum (conferido nas migrations 336, 341 e 360: zero ocorrências).

Consequências práticas:

1. **Não dá para expressar "cada app pode X por minuto".** Só existe o total da
   organização.
2. **Um app movimentado consome a cota inteira** enquanto os outros 32 ficam
   ociosos — e o sistema não tem como perceber.
3. **A cota da organização não protege app nenhum** do limite real da Meta. Ela
   pode estar folgada enquanto um app específico já está sendo estrangulado.

**Correção, e ela espelha o que já foi feito para o lock:** acrescentar
`meta_app_id` à tabela de reservas e passar a contar por app na checagem do
minuto. O caminho é conhecido — a migration 360 fez exatamente esse tipo de
mudança na mesma função, e o padrão de fatiar por chave já está validado.

> **Detalhe que não pode passar batido:** se a cota virar por app, o advisory
> lock também precisa virar por app. Hoje ele é por `(org, provedor, balde do
> perfil)`. Contar por app dentro de um lock que não é por app reintroduz a
> corrida de "dois lêem a mesma contagem e passam juntos" — o mesmo raciocínio
> registrado na 360, só que agora com consequência de estourar limite de
> provedor, não de banco.

---

## ~~RISCO ALTO~~ — o 401 terminal, CORRIGIDO em 04/09

> Corrigido pela sessão da migração, e o mecanismo não era onde este documento
> apontava: não é `isPublicationInfrastructureError` (catch-all de transporte),
> e sim `lib/integrations/instagram-publisher.ts`, onde
> `retryable = status >= 500 || status === 429 || is_transient` fazia 401 e o
> código 190 caírem em `retryable: false` na primeira tentativa. Agora está em
> `lib/integrations/meta-graph-errors.ts` com `isRetryableGraphFailure()`.
> A conclusão deste documento estava certa; a localização, não.

### O raciocínio original

Um HTTP 401 do provedor vira **falha terminal na primeira tentativa**, sem
retentativa. Foi isso que transformou a suspensão da Zernio de 04/09 em **3.263
publicações perdidas** em três horas, e é a mesma classe do incidente de 31/08
(3.315 perdidas) documentado na seção 3-A do mapa de controles.

Com a Meta isso piora por dois motivos:

1. **Token expirado é rotina, não exceção.** Tokens de longa duração da Meta
   valem 60 dias e precisam ser renovados. Expiração devolve 401/190
   (`OAuthException`). Com a Zernio, 401 era catástrofe rara; com a Meta, é
   manutenção normal.
2. **O raio de alcance multiplicou por 100.** Um token expirado hoje derruba uma
   conta. Depois da migração, derruba os **100 perfis daquele app** de uma vez.

**Erro de autenticação é externo e transitório: deve adiar, nunca encerrar.**
A correção é no mesmo módulo que já trata o `fetch failed` do incidente de
31/08, `lib/publications/infrastructure-error.ts`.

---

## A VERIFICAR antes de virar

- **O que os 100 de `instagram_slot_limit` contam.** A migration 366 descreve
  como vagas de conta por app, o que está certo. Mas a Meta também tem limite de
  *chamadas* por app, que é outro eixo e não está modelado em lugar nenhum.
  Nenhum código lê `X-App-Usage` hoje — conferido em `lib/integrations/meta-*.ts`
  e no despachante.
- **O gancho de reciclagem de perfil** (`schedule_zernio_profile_disconnection`)
  não tem equivalente para a Meta. Falha de publicação num perfil `meta_official`
  hoje não dispara nada. Decidir se precisa de equivalente ou se some.
- **Perfis legados com `meta_app_id` nulo.** A 366 deixa os já conectados sem
  app de propósito. Se a cota passar a ser por app, esses perfis ficam num
  balde "sem app" que precisa de regra própria.

---

## Resumo

| item | estado |
|---|---|
| Programar em massa | **pronto**, agnóstico de provedor |
| Modelo de dados multi-provedor | **pronto** desde a 053 |
| Fatiamento do lock | **pronto**, agnóstico |
| Limite por perfil (24 h, espaçamento) | **pronto** |
| Linha de rate limit `meta_official` | **feito** — migration 369 |
| Cota por app | **feito** — migration 372, teto nulo até ser medido |
| 401 como erro transitório | **feito** — `isRetryableGraphFailure` |
| Renovação de token | **feito** — worker + política, 14 tokens renovados |
| Leitura de `X-App-Usage` | **FALTA** — é o que dá o número da cota por app |
| Agendamento diário da renovação | **FALTA** — worker existe, ninguém o chama ainda |

**Atualização de 04/09:** os três itens que faltavam foram fechados no mesmo dia.
Sobram dois, e nenhum é bloqueador de virada:

- **`X-App-Usage`** — ninguém lê o cabeçalho ainda. É ele que dá o número real
  para configurar a cota por app; enquanto não for lido, a cota fica pronta mas
  desligada.
- **Agendamento da renovação** — o worker existe e funciona, mas nada o chama de
  hora em hora. Enquanto for manual, a garantia de 60 dias depende de alguém
  lembrar, que é exatamente o que ele existe para evitar.
