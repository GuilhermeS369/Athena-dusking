// Leitura das linhas coladas no campo "Contas" do bulk import.
//
// Formato curto, o que a tela já usava: `usuario:senha:2fa` ou `usuario;senha;2fa`
// (exatamente três campos separados por `:` ou `;`).
//
// Formato completo, com os campos separados por `|`, por `----` ou por `:` (quatro
// campos ou mais). A ordem muda conforme o fornecedor do lote — exemplos reais:
//
//   login|senha|2fa|email|senha do email|client_id|refresh_token|access_token|access_secret|device|cookie
//   login|senha|email|senha do email|OAUTH2|2fa|token
//   login:senha:2fa:email:senha do email:token_longo:auth_token
//   login:senha:email:2fa:token_longo:auth_token  (2fa logo após o e-mail, sem senha do e-mail)
//   login----senha----email----senha do email----2fa----auth_token  (campo vazio vira `--------`)
//   login:senha:email|senha do email|refresh_token|client_id:auth_token:2fa  (mistura `:` e `|`)
//   login|senha|email|senha do email|telefone|token_longo|auth_token|2fa|data|n|n|n|false|pais| email|senha|refresh_token|client_id
//
// Metadados que alguns lotes carregam (telefone, data, contadores, booleano,
// país, e o e-mail/refresh repetidos) são reconhecidos e ignorados na planilha,
// menos o telefone, que vai para a observação. Um cookie que chegue em base64 é
// decodificado para extrair o auth_token.
//
// Por isso nada aqui depende da posição, fora login e senha, que são sempre os
// dois primeiros. Cada campo seguinte é reconhecido pelo que ele é: e-mail tem
// `@` e domínio, o 2FA é Base32, o cookie tem `chave=valor`, o auth_token são 40
// caracteres hexadecimais, o client_id é um UUID. Campo vazio pode vir como `-`.
//
// Só login, senha, 2FA, e-mail, senha do e-mail, device e cookie viram coluna na
// planilha; os campos de OAuth são guardados como vierem.

export type MoreLoginAccount = {
  id: string;
  line: number;
  profileName: string;
  login: string;
  password: string;
  twoFa: string;
  email: string;
  emailPassword: string;
  clientId: string;
  refreshToken: string;
  accessToken: string;
  accessSecret: string;
  phone: string;
  cookie: string;
  /** Valor de `auth_token`, avulso ou extraído do cookie (inclusive base64) — é o que loga o perfil no X. */
  authToken: string;
};

export type MoreLoginAccountError = { line: number; text: string; reason: string };

const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASE32_PATTERN = /^[A-Z2-7]{16,64}$/;
const HEX_TOKEN_PATTERN = /^[0-9a-f]{40}$/i;
const ACCESS_TOKEN_PATTERN = /^\d{6,}-[A-Za-z0-9]+$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
const LONG_TOKEN_LENGTH = 80;

export function normalizeTwoFaSecret(value: string) {
  return value.replace(/\s+/g, '').replace(/-/g, '').toUpperCase();
}

// Telefone: só dígitos (com + e separadores), nove ou mais dígitos. Nove evita
// confundir com data (dd-mm-yyyy tem oito) ou com os contadores curtos do lote.
const PHONE_PATTERN = /^\+?\d{9,}$/;
function isPhone(value: string) {
  return PHONE_PATTERN.test(value.replace(/[\s()-]/g, ''));
}

// Base64 que decodifica para texto imprimível — usado para achar um cookie que
// veio codificado. Vale no navegador (atob global) e no Node 22.
function decodeBase64(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 24 || trimmed.length % 4 !== 0 || !BASE64_PATTERN.test(trimmed)) return '';
  try {
    const decoded = atob(trimmed);
    // Só serve se for texto legível (cookie/JSON), não binário.
    return /[^\t\n\r\x20-\x7e]/.test(decoded) ? '' : decoded;
  } catch {
    return '';
  }
}

const AUTH_TOKEN_IN_TEXT = /(?:^|[;,\s"'])auth_token["']?\s*[=:]\s*["']?([0-9a-f]{40})/i;

export function extractAuthToken(value: string) {
  const raw = value.trim();
  const direct = raw.match(AUTH_TOKEN_IN_TEXT);
  if (direct) return direct[1];
  // Linha que trouxe só o token, sem o resto do cookie.
  if (HEX_TOKEN_PATTERN.test(raw)) return raw;
  // Cookie que chegou em base64 — decodifica e procura de novo ("faz converter").
  const decoded = decodeBase64(raw);
  if (decoded) {
    const fromBase64 = decoded.match(AUTH_TOKEN_IN_TEXT);
    if (fromBase64) return fromBase64[1];
    if (HEX_TOKEN_PATTERN.test(decoded.trim())) return decoded.trim();
  }
  return '';
}

function isCookie(value: string) {
  if (value.includes('auth_token=') || (value.includes('=') && value.includes(';'))) return true;
  // Cookie codificado em base64 que, decodificado, carrega um auth_token.
  return Boolean(extractAuthToken(value)) && decodeBase64(value) !== '';
}

type Slot = 'cookie' | 'clientId' | 'refreshToken' | 'accessToken' | 'authToken' | 'twoFa' | 'phone' | 'extra';

function classify(value: string): Slot {
  // Cookie (inclusive base64) vem antes da regra de comprimento, senão um cookie
  // longo cairia como refresh_token.
  if (isCookie(value)) return 'cookie';
  if (UUID_PATTERN.test(value)) return 'clientId';
  if (isPhone(value)) return 'phone';
  if (ACCESS_TOKEN_PATTERN.test(value)) return 'accessToken';
  if (HEX_TOKEN_PATTERN.test(value)) return 'authToken';
  if (BASE32_PATTERN.test(normalizeTwoFaSecret(value))) return 'twoFa';
  if (value.length > LONG_TOKEN_LENGTH) return 'refreshToken';
  return 'extra';
}

type RawAccount = Omit<MoreLoginAccount, 'id' | 'line' | 'profileName'>;

const EMPTY: Omit<RawAccount, 'login' | 'password'> = {
  twoFa: '', email: '', emailPassword: '', clientId: '', refreshToken: '', accessToken: '', accessSecret: '', phone: '', cookie: '', authToken: '',
};

function parseExtendedLine(rawParts: string[]): RawAccount {
  // Campo vazio pode chegar como `-` (um traço) ou como só traços — restos do
  // separador `----` quando um campo do meio veio em branco.
  const parts = rawParts.map((part) => (/^-+$/.test(part.trim()) ? '' : part.trim()));
  const account: RawAccount = { ...EMPTY, login: parts[0] ?? '', password: parts[1] ?? '' };
  const consumed = new Set([0, 1]);

  // O e-mail é achado pelo formato. O campo seguinte costuma ser a senha dele,
  // mas em alguns lotes é o próprio 2FA (login:senha:email:2fa:...). A senha do
  // e-mail é sempre minúscula/alfanumérica; o 2FA é Base32 em maiúsculas. Então,
  // se o campo seguinte tem cara de 2FA, deixo para o classificador pegá-lo como
  // chave, em vez de gravá-lo como senha do e-mail.
  const emailIndex = parts.findIndex((value, index) => index >= 2 && EMAIL_PATTERN.test(value));
  if (emailIndex !== -1) {
    account.email = parts[emailIndex];
    consumed.add(emailIndex);
    const next = parts[emailIndex + 1];
    if (next && !EMAIL_PATTERN.test(next) && !isCookie(next) && !BASE32_PATTERN.test(next)) {
      account.emailPassword = next;
      consumed.add(emailIndex + 1);
    }
  }

  const extras: string[] = [];
  parts.forEach((value, index) => {
    if (consumed.has(index) || !value) return;
    // Primeiro do tipo ganha o campo: nos dois layouts o 2FA vem antes do
    // access_secret, que é o único outro candidato plausível a Base32.
    const slot = classify(value);
    if (slot === 'extra') extras.push(value);
    else if (slot === 'twoFa') account.twoFa = account.twoFa || normalizeTwoFaSecret(value);
    else if (!account[slot]) account[slot] = value;
    else extras.push(value);
  });

  if (account.accessToken) {
    const secretIndex = extras.findIndex((value) => value.length >= 30);
    if (secretIndex !== -1) account.accessSecret = extras.splice(secretIndex, 1)[0];
  }

  account.authToken = account.authToken || extractAuthToken(account.cookie);
  return account;
}

function parseShortLine(parts: string[]): RawAccount {
  return {
    ...EMPTY,
    login: parts[0]?.trim() ?? '',
    password: parts[1]?.trim() ?? '',
    twoFa: normalizeTwoFaSecret(parts.slice(2).join('')),
  };
}

// Um campo é cookie quando carrega `auth_token=` ou pares `nome=valor;` — o único
// caso em que `;`/`:` fazem parte do dado e não podem virar separador.
function hasCookieField(parts: string[]) {
  return parts.some((part) => part.includes('auth_token=') || (part.includes('=') && part.includes(';')));
}

// Decide o separador e se a linha é completa. `|` e `----` são sempre completos.
// Com `:`/`;`, três campos ou menos é o curto `usuario:senha:2fa`; quatro ou mais
// é um lote completo delimitado por `:`.
function splitLine(line: string): { extended: boolean; parts: string[] } {
  // Separador `----`: um campo vazio do meio aparece como `--------` (dois
  // separadores seguidos). Divido pela unidade de quatro traços para preservar
  // essa posição vazia — colapsá-la empurraria o 2FA para o lugar da senha do
  // e-mail.
  if (line.includes('----')) return { extended: true, parts: line.split('----') };
  if (line.includes('|')) {
    const byPipe = line.split('|');
    // Alguns lotes misturam `|` e `:` como separador na mesma linha. Se não há
    // cookie (onde `:`/`;` são dados), trato os dois como separador para não
    // deixar `login:senha:email` grudado num campo só. Com cookie, divido só por
    // `|` para não picotá-lo.
    if (hasCookieField(byPipe)) return { extended: true, parts: byPipe };
    return { extended: true, parts: line.split(/[|:]/) };
  }
  const parts = line.split(/[:;]/);
  return { extended: parts.length > 3, parts };
}

export function parseMoreLoginAccounts(input: string) {
  const accounts: MoreLoginAccount[] = [];
  const errors: MoreLoginAccountError[] = [];
  input.split(/\r?\n/).forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line) return;
    // Cabeçalhos "Account #1" que alguns exports intercalam entre os registros —
    // não são conta e não podem bloquear o download como linha inválida.
    if (/^account\s*#?\s*\d+$/i.test(line)) return;
    const { extended, parts } = splitLine(line);
    const raw = extended ? parseExtendedLine(parts) : parseShortLine(parts);
    if (!raw.login || !raw.password) {
      errors.push({ line: index + 1, text: rawLine, reason: extended ? 'Formato completo precisa de pelo menos login|senha|2fa.' : 'Use usuario:senha:2fa ou usuario;senha;2fa.' });
      return;
    }
    // No formato curto o 2FA sempre fez parte da linha; no completo ele pode
    // vir vazio sem que a linha deixe de servir.
    if (!extended && !raw.twoFa) {
      errors.push({ line: index + 1, text: rawLine, reason: 'Usuário, senha e 2FA são obrigatórios.' });
      return;
    }
    accounts.push({ id: `${index}-${raw.login}`, line: index + 1, profileName: raw.login.slice(0, 64), ...raw });
  });
  return { accounts, errors };
}

/** Coluna "Cookie": formato que a planilha do MoreLogin documenta para o X. */
export function buildMoreLoginCookie(account: MoreLoginAccount) {
  return account.authToken ? `auth_token=${account.authToken}` : '';
}

/** Coluna "Profile note": o que um operador precisa ler dentro do perfil. */
export function buildMoreLoginProfileNote(account: MoreLoginAccount) {
  return [
    account.email ? `email: ${account.email}` : '',
    account.emailPassword ? `senha do email: ${account.emailPassword}` : '',
    account.phone ? `telefone: ${account.phone}` : '',
  ].filter(Boolean).join('\n');
}
