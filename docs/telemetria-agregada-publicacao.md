# Telemetria agregada de publicação

## Finalidade

Esta telemetria permite acompanhar capacidade, atraso, adiamentos e falhas de publicação sem criar um novo log para cada postagem. Ela reutiliza estados e eventos que a fila já persiste e adiciona apenas um resumo por ciclo do worker.

## Dados gravados

O worker de publicação passa a registrar, no evento de ciclo concluído, apenas:

- quantidade de itens reivindicados;
- totais por resultado (`published`, `failed`, `dispatch_rate_limit`, entre outros);
- resumo de recuperação de horários e slots coletivos;
- total de reciclagens Zernio executadas;
- totais já agregados da fila no instante do ciclo.

Não são gravados na telemetria de ciclo IDs de publicações, URLs, tokens, conteúdos de mídia, legendas ou listas de itens. O histórico individual existente de `publication_item_events` continua sendo usado somente para investigação e paginação de detalhes.

## Relatório na Central operacional

Depois de aplicar a migration `171_publication_dispatch_telemetry.sql`, a Central operacional exibe, para o superusuário, a janela das últimas 24 horas com:

- claims e duração p95 dos ciclos;
- itens adiados por limite de despacho;
- sucesso, falha e atraso p95 por provedor;
- erros consolidados por provedor e código, com contagem e última mensagem curta;
- alertas de atraso, lease expirado, falha elevada e ciclos interrompidos.

Caso a migration ainda não esteja aplicada, a tela mostra um estado de espera para o relatório novo sem afetar os demais painéis operacionais.

## Como avaliar um pico horário

Para avaliar, por exemplo, três organizações com 500 publicações no mesmo horário:

1. Registrar o horário do pico.
2. Abrir a Central operacional após 5, 10 e 15 minutos.
3. Conferir `claims`, publicados por provedor, atraso p95, adiamentos por capacidade e backlog/atraso máximo.
4. Confirmar que o backlog volta próximo de zero antes do pico seguinte.
5. Se houver falha, usar o agrupamento `provedor + error_code`; abrir os detalhes individuais somente para a amostra necessária.

O sinal de capacidade saudável não é CPU baixa isoladamente: é vazão de drenagem maior que a taxa de chegada, sem crescimento sustentado do backlog, atraso p95 elevado, leases expirados ou aumento de erros externos.

## Auditoria futura assistida por IA

Após existir uma janela representativa de picos reais, uma auditoria assistida por IA deve consultar este relatório, o throughput já existente, alertas e amostras paginadas de eventos. A auditoria deve produzir documento datado com:

- volume recebido e drenado por janela;
- atraso p50/p95/p99 e atraso máximo;
- falhas e adiamentos por provedor;
- comparação entre capacidade esperada e observada;
- decisão fundamentada de manter, aumentar ou reduzir limites/concurrency.

Ela não deve depender de logs completos por publicação.
