'use client';

import { createContext, useContext } from 'react';

// O valor nasce no servidor (isLegacySchedulingEnabled em app/(painel)/layout.tsx),
// entra no AppShell por prop e é distribuído daqui para os atalhos que levam à
// tela de Postagem. Fora do AppShell o padrão é desligado.
const LegacySchedulingContext = createContext(false);

export const LegacySchedulingProvider = LegacySchedulingContext.Provider;

export function useLegacySchedulingEnabled() {
  return useContext(LegacySchedulingContext);
}
