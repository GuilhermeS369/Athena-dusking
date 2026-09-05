# Plano — coleta pela API da Meta e dashboard

**Aberto em 05/09/2026.** Registro do que ficou combinado e do que falta, para
não depender de memória de conversa. O que já foi feito está em
[docs/dashboard-e-coleta-meta-2026-09-05.md](../docs/dashboard-e-coleta-meta-2026-09-05.md).

O pano de fundo: a Zernio sai de cena por tempo indeterminado e a operação passa
a ser **só API da Meta**. Todo dimensionamento abaixo assume isso.

---

## Etapa 1 — histórico do perfil caído volta a aparecer  ✅ feito

**Problema.** Quando um perfil é removido, a dashboard esquece que ele existiu:
os dias em que ele publicou somem dos totais, dos gráficos e do ranking.

**Descoberta que muda o tamanho do trabalho:** o dado nunca foi perdido. As
26.101 linhas de `profile_analytics_daily_metrics` continuam lá, inclusive as
dos 2.440 perfis removidos — `soft_delete_profile_analytics` nunca tocou nessa
tabela. O que esconde o histórico é a leitura: `scoped_profiles`, nas RPCs da
dashboard, filtra `profile.deleted_at is null`.

**Desenho combinado:**

- métrica (KPIs, séries, por fonte, por grupo, ranking) passa a **incluir**
  perfis removidos — o passado da organização inclui quem caiu;
- a **lista de perfis** do filtro e o indicador de capacidade continuam só com
  quem está de pé — eles falam do presente;
- a **cobertura** (`selected_profiles`, `profiles_with_metrics`) continua contada
  sobre perfis ativos, senão a fração passa a comparar coisas diferentes;
- no ranking, perfil removido aparece **marcado**, para ninguém clicar num
  perfil que não existe mais.

**Resultado medido:** 44,5% do histórico dos últimos 30 dias estava fora da tela
(5.155.240 views de perfis removidos contra 6.422.628 de ativos), e **6 dos 10
primeiros do ranking** eram perfis que não apareciam. Custo: a consulta de 30
dias foi de 159 ms para 256 ms em regime.

---

## Etapa 2 — o "hoje" via insights por post  ✅ feito

**Por que existe.** O endpoint de conta (`/me/insights`) não entrega o dia
corrente: medido com sete formatos de janela, a Meta só publica o dia depois que
ele fecha no fuso da conta (07:00 UTC, meia-noite no Pacífico). O único caminho
para o dia de hoje é `/{media-id}/insights`, que responde desde a publicação.

**O que muda de significado.** O número passa a ser *"desempenho do que saiu
hoje"* em vez de *"views da conta no dia"*. Para esta operação isso é
possivelmente melhor, mas é uma mudança de definição e precisa ser consciente.

**NÃO EXISTE LOTE NESTA API — corrige uma estimativa que eu tinha dado errada.**
Duas formas foram testadas em 05/09/2026 e nenhuma funciona em
`graph.instagram.com` v26:

```
?ids=a,b,c&fields=insights.metric(...)  -> 500 "The ids query parameter is deprecated in v26.0+"
POST /?batch=[{method,relative_url}]    -> 400, corpo vazio
```

É **uma chamada por post**. A conta muda:

| item | valor |
|---|---:|
| chamadas por perfil que publicou | 26 (1 lista de mídias + 25 posts) |
| chamadas por perfil que não publicou | 4 |
| a 5.000 perfis (metade publicando) | ~85.000 chamadas por rodada |
| tempo de trabalho por rodada | ~75 min (contra os ~80 s que eu estimei com lote) |
| **escritas no banco** | **1 linha por perfil** — a soma vai em memória |

O custo é de worker, não de banco — e é por isso que a decisão de três rodadas
por dia continua valendo. Com a frota de hoje (~800 publicando) a rodada leva
~18 minutos.

**Invariante que não pode cair:** somar em memória e gravar só a linha diária.

**Armadilha registrada:** a primeira versão engolia o erro do lote com um
`continue` e gravava linha de zeros — 108 perfis com "13 posts, 0 views" antes
de alguém notar. A linha do dia corrente agora exige métrica de verdade, não só
contagem de posts.

---

## Etapa 3 — frequência do `collectPosts`  ✅ feito (absorvida pela etapa 2)

Hoje a lista de mídias é coletada de hora em hora e grava uma linha por post —
9.713 escritas/hora com 802 perfis, ~80% de toda a escrita da coleta. Com 2.000
perfis vira ~50 mil/hora.

Fica junto da etapa 2 porque as duas mexem no mesmo lugar: se o "hoje" passar a
ler mídias por perfil, a lista já vem junto e a coleta separada perde sentido.

**Resolvido:** a lista de mídias passou a ser coletada dentro da rodada, três
vezes ao dia — é dela que saem os ids para o "hoje". A coleta separada de hora
em hora deixou de existir.

---

## Fechado nesta rodada (para referência)

- **Retenção de 90 dias** em `profile_post_analytics_snapshots`, com o teto da
  janela da Recuperação baixado de 180 para 90 — os dois números precisam
  concordar, e o de 180 nunca foi usado (todas as execuções registradas usam 30).
  **Para voltar a análises mais longas, suba os dois juntos** (migration 385).
- **Perfil removido não guarda métrica por post.** O limpador apaga em vez de
  marcar; 99.178 linhas drenadas (38% da tabela). A métrica DIÁRIA fica.
- **Coleta delegada ao worker da VPS** — `athena-vps-profile-analytics-1`, que já
  estava de pé e ocioso, agora coleta a Meta pelo mesmo endpoint que já chamava.
  O cron da Vercel virou rede de segurança (`staleMinutes` 60). **Medido na
  rodada das 15:00 de 05/09/2026, do início ao fim: 1.741 perfis distintos em
  35,9 minutos (49 perfis/min), 100% da frota, 1,00x de repetição, 34.373 linhas
  escritas — 103 mil/dia em três rodadas.** A estimativa de ~14 min que estava
  aqui antes vinha de uma medição com quatro chamadores simultâneos, onde quase
  metade do trabalho era repetido.


---

## Etapa 4 — três rodadas por dia, e o botão sai  ✅ feito

A coleta acontece às **09:00, 15:00 e 21:00** (fuso da operação). Fora disso o
despachante não faz nada.

O botão "atualizar" saiu: ele varria a frota a cada clique e a pergunta real do
operador era "esse número está fresco?". No lugar ficou um **indicador** — um
ponto que gira durante a rodada e mostra, no hover, o progresso ("640 de 1.719
perfis, 37%"), o horário da conclusão e o do próximo ciclo. Quando a rodada
termina com a tela aberta, os agregados são buscados de novo sozinhos.

`meta_analytics_runs` (migration 387) é o objeto por trás disso: uma linha por
horário por dia, com início, progresso e fim.

**Bug corrigido na 388:** `timezone('America/Sao_Paulo', timezone('utc', now()))`
são duas conversões, e a segunda vai no sentido oposto — o banco achava que eram
18:58 quando eram 12:58. Seis horas. Teria aberto a rodada das 09:00 por volta
das 03:00. Quem denunciou foi a tela, mostrando "próxima coleta às 21:00" às
treze horas.

**Bug corrigido na 390:** a rodada nunca terminava. O critério "ainda não
visitado nesta rodada" tinha virado `staleMinutes = minutos desde o início`, uma
janela que anda junto com a rodada — aos 19 minutos, o perfil coletado no minuto
zero volta a ser elegível. Medido: 2.131 de 1.683 perfis (127%) e subindo. Agora
o critério é o instante de abertura da rodada (`p_collected_before`), que não se
move, e a assinatura antiga foi derrubada.

---

## Pendente — 5 apps da Meta com acesso bloqueado  ⚠️ depende de você

Não é bug do Athena: a Meta bloqueou os apps. A coleta e a publicação recebem a
mesma resposta.

| app | app_id | perfis online travados |
|---|---|---:|
| Julio Lote 1 / 04/09-IG | 1066347255995731 | 90 |
| Lari Lote 1 / 04/09-IG | 1788523709159447 | 68 |
| Lari Lote 2 / 04/09-IG | 1609745000290856 | 53 |
| Julio Lote 2 / 04/09-IG | 1995345244504125 | 38 |
| PeachySara Lote 1 / 04/09-IG | 1073350442352405 | 10 |

**259 perfis, 100% de cada um desses apps** — nenhum perfil deles responde.
Código 200, mensagem `API access blocked.`

Custo já pago, medido em 05/09/2026 nas últimas 24h: **136 publicações
falharam** com essa mensagem (de 148 falhas no total — as outras 12 são timeout
de container e vídeo malformado, coisa normal).

O que fazer: abrir cada app no painel de desenvolvedores da Meta e ver o aviso
de restrição. Enquanto não sair, esses 259 perfis não publicam nem geram métrica.

### Dois outros códigos, muito menores

- **`meta_190`** — "You cannot access the app till you log in to
  www.instagram.com and follow the instructions given": 19 perfis online,
  espalhados por vários apps. É a conta em checkpoint de verificação, não o app.
  **Decisão já fechada: conta em checkpoint é descartável** — remover e ignorar,
  sem segunda leitura.
- **`meta_10`** — "Application does not have permission for this action":
  14 perfis, quase todos no `duskingapp` (o app original). Escopo de permissão
  antigo; reconectar o perfil por um app novo resolve.


---

## Pendente — a seleção do lote não tem reserva

`select_meta_analytics_refresh_batch` é um SELECT puro. Dois chamadores ao mesmo
tempo recebem os mesmos perfis e coletam os dois: medido em 05/09/2026, com
quatro chamadores simultâneos a rodada contou 3.276 processados para 1.130
perfis distintos (2,90x) e deixou 546 sem visita.

Hoje isso não morde porque só existe um chamador (`athena-vps-profile-analytics-1`,
laço sequencial) — a rodada das 09:00, conduzida só por ele, fechou sozinha em
95% e 29 minutos. Morde no dia em que alguém subir um segundo worker, duplicar o
processo no PM2 ou chamar o endpoint na mão — e o sintoma é justamente o que o
Supabase não deve levar: escrita duplicada.

Duas saídas, nenhuma cara:

1. **Trava na rodada** (preferida): `meta_analytics_runs` ganha `claimed_until`,
   e quem abre o lote a renova. Uma escrita por lote — ~56 por rodada, ~170 por
   dia. Só um chamador trabalha por vez, que é o que a rodada já significa.
2. **Reserva por perfil**: uma coluna `claimed_at` em `profile_analytics_current`.
   Correta e mais granular, mas custa uma escrita por perfil (1.676 por rodada,
   ~5 mil por dia) — pagar isso só se algum dia a coleta precisar de paralelismo
   de verdade.
