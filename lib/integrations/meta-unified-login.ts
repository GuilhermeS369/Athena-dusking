// Importes relativos com extensao pelo mesmo motivo de meta-token-refresh.ts: o
// teste roda direto no node, que nao resolve o alias `@/`.
import { META_GRAPH_API_VERSION } from './meta-oauth.ts';

/**
 * Unified Login: a rota alternativa de conexão, para apps criados depois que a
 * Meta tirou o Instagram Login dos apps novos (out/2026).
 *
 * O que muda em relação ao fluxo de `meta-oauth.ts`, conforme a documentação da
 * Meta (developers.facebook.com/documentation/instagram-platform):
 *   - o link leva `config_id`, criado no painel da Meta, no lugar de `scope`;
 *   - a credencial é a do app da Meta, não a do "app do Instagram";
 *   - o token é de system user, pertence ao portfólio e cobre TODAS as contas
 *     que a pessoa compartilhou, então um login pode trazer mais de uma conta;
 *   - `/me` responde pelo system user, nunca pela conta do Instagram;
 *   - a API é `graph.facebook.com`, sempre com o id da conta no caminho.
 */

export const META_UNIFIED_GRAPH_ORIGIN = 'https://graph.facebook.com';

/** Teto de páginas da lista de contas de um token, para nunca girar em falso. */
const MAX_ACCOUNT_PAGES = 50;

type FetchImpl = typeof fetch;

export type MetaUnifiedAccount = {
  id: string;
  username: string;
  name: string | null;
  profilePictureUrl: string | null;
};

type GraphErrorBody = {
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
    fbtrace_id?: string;
  };
};

/** Falha com o que a Meta respondeu: o piloto existe para ler este diagnóstico. */
export class MetaUnifiedError extends Error {
  // Campos declarados um a um: o node roda este arquivo por type stripping, que
  // não aceita `readonly` em parâmetro de construtor.
  stage: string;
  httpStatus: number | null;
  graphError: GraphErrorBody['error'] | null;

  constructor(
    stage: string,
    httpStatus: number | null,
    graphError: GraphErrorBody['error'] | null,
    message: string,
  ) {
    super(message);
    this.name = 'MetaUnifiedError';
    this.stage = stage;
    this.httpStatus = httpStatus;
    this.graphError = graphError;
  }

  toDiagnostic(extra: Record<string, unknown> = {}) {
    return JSON.stringify({
      stage: this.stage,
      httpStatus: this.httpStatus,
      error: this.graphError
        ? {
          code: this.graphError.code,
          subcode: this.graphError.error_subcode,
          type: this.graphError.type,
          message: this.graphError.message,
          fbtrace_id: this.graphError.fbtrace_id,
        }
        : { message: this.message },
      ...extra,
    });
  }
}

export function buildMetaUnifiedLoginUrl(
  state: string,
  redirectUri: string,
  clientId: string,
  configId: string,
) {
  const url = new URL(`https://www.facebook.com/${META_GRAPH_API_VERSION}/dialog/oauth`);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('config_id', configId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  // Token de system user só vem por código com este parâmetro ligado.
  url.searchParams.set('override_default_response_type', 'true');
  // Sem ele, quem já tem sessão no Facebook continua naquela conta e nem vê a
  // opção de entrar com o Instagram. Em celular de operação isso escolheria a
  // conta errada em silêncio.
  url.searchParams.set('prompt', 'login');
  url.searchParams.set('state', state);
  return url;
}

export function metaUnifiedGraphUrl(path: string) {
  return `${META_UNIFIED_GRAPH_ORIGIN}/${META_GRAPH_API_VERSION}/${path.replace(/^\//, '')}`;
}

async function graphGet<T>(
  stage: string,
  url: string,
  params: Record<string, string>,
  accessToken: string | null,
  fetchImpl: FetchImpl,
) {
  const target = new URL(url);
  for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value);

  const response = await fetchImpl(target, {
    headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined,
    cache: 'no-store',
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.json().catch(() => ({})) as T & GraphErrorBody;

  if (!response.ok || body.error) {
    throw new MetaUnifiedError(
      stage,
      response.status,
      body.error ?? null,
      body.error?.message ?? `A Meta respondeu HTTP ${response.status} em ${stage}.`,
    );
  }

  return body;
}

export async function exchangeMetaUnifiedCode(
  input: { clientId: string; clientSecret: string; code: string; redirectUri: string },
  fetchImpl: FetchImpl = fetch,
) {
  const body = await graphGet<{ access_token?: string; expires_in?: number }>(
    'unified_token_exchange',
    metaUnifiedGraphUrl('oauth/access_token'),
    {
      client_id: input.clientId,
      client_secret: input.clientSecret,
      redirect_uri: input.redirectUri,
      code: input.code,
    },
    null,
    fetchImpl,
  );

  if (!body.access_token) {
    throw new MetaUnifiedError('unified_token_exchange', 200, null, 'A Meta não devolveu o token.');
  }

  // O prazo depende da configuração criada no painel; sem `expires_in`, não expira.
  return { accessToken: body.access_token, expiresIn: body.expires_in ?? null };
}

/** Nulo em vez de erro: guardar o id do portfólio não pode custar a conexão. */
export async function fetchMetaUnifiedBusinessId(accessToken: string, fetchImpl: FetchImpl = fetch) {
  try {
    const body = await graphGet<{ client_business_id?: string }>(
      'unified_business_id',
      metaUnifiedGraphUrl('me'),
      { fields: 'client_business_id' },
      accessToken,
      fetchImpl,
    );
    return body.client_business_id ?? null;
  } catch {
    return null;
  }
}

type AssignedAccountRow = {
  id?: string | number;
  username?: string;
  name?: string;
  profile_picture_url?: string;
};

function toAccount(id: string, row: AssignedAccountRow): MetaUnifiedAccount | null {
  if (!row.username) return null;
  return {
    id,
    username: row.username,
    name: row.name ?? null,
    profilePictureUrl: row.profile_picture_url ?? null,
  };
}

export async function fetchMetaUnifiedAccount(
  instagramAccountId: string,
  accessToken: string,
  fetchImpl: FetchImpl = fetch,
) {
  return graphGet<AssignedAccountRow>(
    'unified_account_lookup',
    metaUnifiedGraphUrl(encodeURIComponent(instagramAccountId)),
    { fields: 'username,name,profile_picture_url' },
    accessToken,
    fetchImpl,
  );
}

/**
 * Lista as contas que este token enxerga. A documentação não diz quais campos a
 * lista devolve, então a conta sem `username` é completada por uma leitura dela.
 */
export async function listMetaUnifiedAccounts(accessToken: string, fetchImpl: FetchImpl = fetch) {
  const ids = new Map<string, AssignedAccountRow>();
  let after: string | null = null;

  for (let page = 0; page < MAX_ACCOUNT_PAGES; page += 1) {
    const body: {
      data?: AssignedAccountRow[];
      paging?: { cursors?: { after?: string }; next?: string };
    } = await graphGet(
      'unified_account_list',
      metaUnifiedGraphUrl('me/assigned_instagram_accounts'),
      { limit: '100', ...(after ? { after } : {}) },
      accessToken,
      fetchImpl,
    );

    for (const row of body.data ?? []) {
      if (row.id !== undefined && row.id !== null) ids.set(String(row.id), row);
    }

    after = body.paging?.next ? body.paging.cursors?.after ?? null : null;
    if (!after) break;
  }

  const accounts: MetaUnifiedAccount[] = [];
  for (const [id, row] of ids) {
    const account = toAccount(id, row)
      ?? toAccount(id, await fetchMetaUnifiedAccount(id, accessToken, fetchImpl));
    if (!account) {
      throw new MetaUnifiedError('unified_account_lookup', 200, null, `A conta ${id} veio sem username.`);
    }
    accounts.push(account);
  }

  return accounts;
}
