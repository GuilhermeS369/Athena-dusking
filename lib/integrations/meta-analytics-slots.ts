/**
 * Horários da coleta da Meta, em Brasília. Fonte única: o despachante abre a
 * rodada com esta lista e a tela lê o estado com ela.
 *
 * Em ordem crescente de propósito: `get_meta_analytics_run_status` devolve o
 * PRIMEIRO item como "próxima coleta" quando todos os horários do dia já
 * passaram.
 *
 * Custo medido em 22/09/2026: ~63 mil linhas escritas por rodada (2.500 perfis)
 * e 40–60 minutos de duração. Sete horários dão ~440 mil linhas/dia; o menor
 * intervalo entre eles (3 h) continua acima da rodada mais longa observada.
 */
export const META_ANALYTICS_SLOTS = ['00:00', '06:00', '09:00', '12:00', '15:00', '18:00', '21:00'];
