// Interruptor dos modos antigos de agendar no Instagram: "postar agora",
// "programar" e "programar em massa" (tela de Postagem).
//
// Desde 13/10/2026 as postagens são feitas só pela postagem contínua, na tela
// de Grupos. Os modos antigos foram desativados, não apagados: o código segue
// no repositório e volta com LEGACY_SCHEDULING_ENABLED=true no ambiente do
// servidor (Vercel) seguido de um novo deploy.
//
// Variável de servidor. Nunca use prefixo NEXT_PUBLIC_ nem leia process.env no
// cliente: o valor chega às telas por prop, a partir de um Server Component.
export const LEGACY_SCHEDULING_DISABLED_CODE = 'legacy_scheduling_disabled';

export const LEGACY_SCHEDULING_DISABLED_MESSAGE =
  'A programação por aqui foi desativada. As postagens agora são feitas pela postagem contínua, na tela de Grupos.';

// Só a string exata "true" liga. Ausente, vazio ou qualquer outro valor = desligado.
export function isLegacySchedulingEnabled() {
  return process.env.LEGACY_SCHEDULING_ENABLED === 'true';
}
