import { parseZernioConnectionImport } from '../integrations/zernio-connection-import.ts';

export const TWITTER_MIN_INITIAL_GRANT_MICROS = 15_000;
export const TWITTER_MAX_INITIAL_GRANT_MICROS = 1_000_000_000_000;

export function parseTwitterInitialGrantUsd(value: string) {
  const normalized = value.trim().replace(',', '.');
  if (!/^\d+(?:\.\d{1,6})?$/.test(normalized)) return null;
  const [whole, fraction = ''] = normalized.split('.');
  const micros = BigInt(whole) * BigInt(1_000_000) + BigInt(fraction.padEnd(6, '0'));
  if (
    micros < BigInt(TWITTER_MIN_INITIAL_GRANT_MICROS)
    || micros > BigInt(TWITTER_MAX_INITIAL_GRANT_MICROS)
    || micros > BigInt(Number.MAX_SAFE_INTEGER)
  ) return null;
  return Number(micros);
}

export function formatTwitterGrantInput(micros: number) {
  if (!Number.isSafeInteger(micros) || micros < 0) return '12,00';
  const whole = Math.floor(micros / 1_000_000);
  const fraction = String(micros % 1_000_000).padStart(6, '0').replace(/0+$/, '');
  return fraction ? `${whole},${fraction}` : `${whole},00`;
}

export function parseTwitterZernioImport(
  namesText: string,
  apiKeysText: string,
  initialGrantUsd: string,
  twitterSlotLimit: number,
) {
  const base = parseZernioConnectionImport(namesText, apiKeysText);
  const initialGrantMicros = parseTwitterInitialGrantUsd(initialGrantUsd);
  const optionIssues = [
    ...(initialGrantMicros === null ? [{
      lineNumber: 0,
      field: 'batch' as const,
      message: 'Informe um saldo inicial entre US$ 0,015000 e US$ 1.000.000, com até seis casas decimais.',
    }] : []),
    ...(!Number.isInteger(twitterSlotLimit) || twitterSlotLimit < 1 || twitterSlotLimit > 100 ? [{
      lineNumber: 0,
      field: 'batch' as const,
      message: 'O limite por conexão Zernio deve estar entre 1 e 100 contas X.',
    }] : []),
  ];
  return {
    ...base,
    issues: [...base.issues, ...optionIssues],
    valid: base.valid && optionIssues.length === 0,
    initialGrantMicros,
    twitterSlotLimit,
  };
}
