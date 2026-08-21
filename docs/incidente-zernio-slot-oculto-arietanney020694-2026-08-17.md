# Incidente Zernio — slot remoto oculto no pool ArieTanney020694

**Data:** 17/08/2026  
**Nome curto do incidente:** `zernio-slot-remoto-orfao-arietanney020694`  
**Severidade:** bloqueio operacional de capacidade  
**Estado:** resolvido

## Sintoma observado

O pool Zernio `ArieTanney020694` parecia ter somente uma conta conectada na interface local, exibindo `1/2`.

Ao iniciar uma nova conexão, a validação contra a API da Zernio recusava o fluxo com a mensagem:

> O limite de 2 conta(s) nesta chave Zernio já foi atingido globalmente.

Uma sincronização normal também não fazia a segunda conta aparecer na tela de Perfis.

## Causa raiz

A capacidade de uma chave Zernio é global para a API key, incluindo contas ligadas a profiles remotos isolados usados em tentativas OAuth anteriores.

O pool tinha duas contas remotas:

1. `@erishimizu67`, no profile canônico do pool e visível localmente.
2. `@blazeix5098`, em um profile remoto isolado histórico, ocupando o segundo slot.

A segunda conta não era apresentada no pool porque não pertencia ao profile canônico. Ela também não poderia ser importada para esse pool, pois `@blazeix5098` já tinha uma identidade/perfil local canônico válido vinculado a outra conexão Zernio. Forçar a importação teria criado duplicidade ou reassociação indevida.

O resultado foi a divergência:

- interface local: `1/2`;
- capacidade real da Zernio: `2/2`;
- sincronização comum: não importava a conta isolada, corretamente, para preservar a integridade de identidade.

## Diagnóstico confirmado

- Conta remota órfã removida: `6a80c25177555aae011f0f06` (`@blazeix5098`).
- Profile remoto isolado da conta órfã: `6a80c219e77693d5af4a76b5`.
- Perfil local canônico de `@blazeix5098` preservado: `6f734bcc-0a75-416e-af07-0f42e748f250`.
- Conta remota válida restante no pool: `@erishimizu67`.

Os artefatos de evidência são:

- [auditoria de conflito global](../.zernio-arietanney020694-global-conflict-audit-2026-08-17.json);
- [evidência da remoção do órfão](../.zernio-arietanney020694-orphan-removal-evidence-2026-08-17.json);
- [validação final](../.zernio-arietanney020694-final-validation-2026-08-17.json).

## Correção aplicada

1. Confirmado que a conta ausente da tela era remota, histórica e órfã naquele pool.
2. Confirmado que ela já existia corretamente em outra conexão, portanto não foi movida entre profiles nem recriada por OAuth.
3. Removida somente a conta remota órfã da chave `ArieTanney020694`.
4. Reconsultado o inventário remoto e validado o estado local após a remoção.
5. Corrigida a leitura de capacidade para considerar a ocupação global da API key, sem importar contas de profiles isolados para o profile canônico.

## Estado final

Após a remoção, o pool `ArieTanney020694` ficou em `1/2` de forma real:

- `@erishimizu67` continua visível em Perfis;
- não existe conta remota oculta consumindo o segundo slot;
- há uma vaga efetiva para iniciar uma nova conexão OAuth;
- nenhuma conta válida foi removida, movida ou duplicada.

## Prevenção incorporada

- O início de OAuth consulta a ocupação global da API key.
- Quando houver uma tentativa pós-callback recuperável, o fluxo encaminha para a confirmação existente em vez de abrir outro OAuth.
- O worker mantém recuperação gradual para atrasos de propagação da Zernio e falhas transitórias de rede/proxy.
- A sincronização continua preservando o isolamento de profiles: ela não pode reassociar uma conta pertencente a outro pool apenas para preencher a interface.

## Procedimento se voltar a acontecer

1. Não iniciar repetidas conexões OAuth no mesmo pool.
2. Consultar a capacidade remota global da API key.
3. Comparar as contas remotas por `profileId` com os perfis locais ativos e removidos.
4. Se a conta estiver ligada a outro perfil local válido, não a mover nem duplicar.
5. Remover uma conta remota somente se estiver comprovadamente órfã, com evidência/backup e confirmação pós-remoção.
