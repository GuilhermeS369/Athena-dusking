// Postagem contínua por grupo (migration 443). Contrato em
// plans/plano-postagem-continua-contrato.md, seções 3, 4, 5 e 7.
//
// Este arquivo não importa nada de servidor: as rotas usam a validação e o
// mapeamento de erro, e o painel (client) usa os tipos e os limites. A allowlist
// lê uma env sem `NEXT_PUBLIC_`, então no navegador ela é sempre vazia — quem
// decide se a organização está liberada é a rota, nunca a tela.

export type ContinuousPostingFormat = 'reel' | 'story';
export type ContinuousPostingRotationMode = 'same_order' | 'diversified';

export type ContinuousPostingRuleStats = {
  eligibleProfiles: number;
  eligibleMedia: number;
  /** "Hoje" é o dia em America/Sao_Paulo. */
  postedToday: number;
  inFlight: number;
  skippedToday: number;
  failedToday: number;
  restingProfiles: number;
  nextPostAt: string | null;
};

export type ContinuousPostingRule = {
  id: string;
  groupId: string;
  groupName: string;
  format: ContinuousPostingFormat;
  enabled: boolean;
  enabledAt: string | null;
  sourceGroupId: string;
  sourceGroupName: string | null;
  rotationMode: ContinuousPostingRotationMode;
  postsPerDay: number;
  /** Minutos do dia em America/Sao_Paulo; só em story (reel = null = dia inteiro). */
  windowStartMinute: number | null;
  windowEndMinute: number | null;
  caption: string | null;
  restHours: number;
  pausedAt: string | null;
  pauseReason: string | null;
  stats: ContinuousPostingRuleStats;
};

export const CONTINUOUS_POSTING_NOTICE_KINDS = [
  'skipped_late',
  'skipped_no_media',
  'skipped_slot_conflict',
  'profile_rest',
  'rule_paused',
  'post_failed',
  'post_expired',
  'post_cancelled',
  'profile_disconnected',
] as const;
export type ContinuousPostingNoticeKind = typeof CONTINUOUS_POSTING_NOTICE_KINDS[number];

export type ContinuousPostingNotice = {
  id: string;
  /** `notice` = linha de continuous_posting_notices; `item` = item da fila encerrado. */
  source: 'notice' | 'item';
  itemId: string | null;
  ruleId: string;
  groupId: string;
  groupName: string | null;
  /** Nulo em aviso da regra (`rule_paused`). */
  profileId: string | null;
  username: string | null;
  format: ContinuousPostingFormat;
  kind: ContinuousPostingNoticeKind;
  slotAt: string | null;
  delaySeconds: number | null;
  skippedCount: number | null;
  restingUntil: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
};

export type ContinuousPostingRuleInput = {
  format: ContinuousPostingFormat;
  /** Nulo = o próprio grupo (a rota troca pelo id da URL). */
  sourceGroupId: string | null;
  rotationMode: ContinuousPostingRotationMode;
  postsPerDay: number;
  windowStartMinute: number | null;
  windowEndMinute: number | null;
  caption: string | null;
};

/** Teto de reel: intervalo mínimo de 1.500 s. Teto de story: 100 posts/24 h da Meta. */
export const CONTINUOUS_POSTING_MAX_POSTS_PER_DAY: Record<ContinuousPostingFormat, number> = { reel: 57, story: 100 };
export const CONTINUOUS_POSTING_DEFAULT_POSTS_PER_DAY: Record<ContinuousPostingFormat, number> = { reel: 24, story: 1 };
export const CONTINUOUS_POSTING_MAX_CAPTION_LENGTH = 2200;
export const CONTINUOUS_POSTING_MINUTES_PER_DAY = 1440;
export const CONTINUOUS_POSTING_MAX_CLEAR_IDS = 1000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isContinuousPostingUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/**
 * Mesma leitura de `isBulkVideoVariantAllowed`: vazio = ninguém, `*` = todas, e o
 * que vale são os UUIDs que existem no texto, não o separador, as aspas, a quebra
 * de linha, o BOM ou os bytes nulos que a colagem pelo PowerShell deixa em volta.
 */
export function isContinuousPostingAllowed(organizationId: string, allowlist = process.env.CONTINUOUS_POSTING_ORG_IDS) {
  const text = (allowlist ?? '').replace(/\u0000/g, '').toLowerCase();
  if (/(^|[\s,;"'])\*($|[\s,;"'])/.test(text)) return true;
  const ids: string[] = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) ?? [];
  return ids.includes(organizationId.toLowerCase());
}

export function hasContinuousPostingManageRole(role: string | undefined) {
  return role === 'admin' || role === 'operator';
}

function asRecord(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RangeError('Corpo da requisição inválido.');
  return value as Record<string, unknown>;
}

export function parseContinuousPostingFormat(value: unknown): ContinuousPostingFormat {
  if (value !== 'reel' && value !== 'story') throw new RangeError('Formato inválido: use reel ou story.');
  return value;
}

function parseMinuteOfDay(value: unknown, label: string) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > CONTINUOUS_POSTING_MINUTES_PER_DAY) {
    throw new RangeError(`Informe o ${label} da faixa de horário do story.`);
  }
  return value;
}

/** Corpo do PUT de configuração. Lança `RangeError` com a mensagem para a tela. */
export function parseContinuousPostingRuleInput(value: unknown): ContinuousPostingRuleInput {
  const body = asRecord(value);
  const format = parseContinuousPostingFormat(body.format);

  let sourceGroupId: string | null = null;
  if (body.sourceGroupId !== undefined && body.sourceGroupId !== null) {
    if (!isContinuousPostingUuid(body.sourceGroupId)) throw new RangeError('Origem das mídias inválida.');
    sourceGroupId = body.sourceGroupId.toLowerCase();
  }

  if (body.rotationMode !== 'same_order' && body.rotationMode !== 'diversified') {
    throw new RangeError('Ordem das mídias inválida.');
  }

  const maxPostsPerDay = CONTINUOUS_POSTING_MAX_POSTS_PER_DAY[format];
  if (typeof body.postsPerDay !== 'number' || !Number.isInteger(body.postsPerDay) || body.postsPerDay < 1 || body.postsPerDay > maxPostsPerDay) {
    throw new RangeError(format === 'reel'
      ? `Posts por dia de reels deve ficar entre 1 e ${maxPostsPerDay}.`
      : `Posts por dia de stories deve ficar entre 1 e ${maxPostsPerDay}.`);
  }

  // A faixa só existe em story. Em reel o banco guarda null (dia inteiro), então
  // o que vier no corpo é descartado em vez de recusado.
  let windowStartMinute: number | null = null;
  let windowEndMinute: number | null = null;
  if (format === 'story') {
    windowStartMinute = parseMinuteOfDay(body.windowStartMinute, 'início');
    windowEndMinute = parseMinuteOfDay(body.windowEndMinute, 'fim');
    if (windowStartMinute >= windowEndMinute) throw new RangeError('O início da faixa de horário precisa ser antes do fim.');
  }

  let caption: string | null = null;
  if (body.caption !== undefined && body.caption !== null) {
    if (typeof body.caption !== 'string') throw new RangeError('Legenda inválida.');
    const trimmed = body.caption.trim();
    // Conta caracteres como o Postgres (`char_length`), não unidades UTF-16.
    if ([...trimmed].length > CONTINUOUS_POSTING_MAX_CAPTION_LENGTH) throw new RangeError('A legenda passa de 2.200 caracteres.');
    caption = trimmed || null;
  }

  return { format, sourceGroupId, rotationMode: body.rotationMode, postsPerDay: body.postsPerDay, windowStartMinute, windowEndMinute, caption };
}

/** Corpo do POST da chave. */
export function parseContinuousPostingToggleInput(value: unknown) {
  const body = asRecord(value);
  const format = parseContinuousPostingFormat(body.format);
  if (typeof body.enabled !== 'boolean') throw new RangeError('Informe se a chave deve ligar ou desligar.');
  return { format, enabled: body.enabled };
}

function parseUuidList(value: unknown) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new RangeError('Lista de avisos inválida.');
  const ids = new Set<string>();
  for (const id of value) {
    if (!isContinuousPostingUuid(id)) throw new RangeError('Lista de avisos inválida.');
    ids.add(id.toLowerCase());
  }
  return [...ids];
}

/** Corpo do POST de limpar avisos: `noticeIds` (avisos) e `itemIds` (itens da fila). */
export function parseContinuousPostingClearInput(value: unknown) {
  const body = asRecord(value);
  const noticeIds = parseUuidList(body.noticeIds);
  const itemIds = parseUuidList(body.itemIds);
  const total = noticeIds.length + itemIds.length;
  if (total === 0 || total > CONTINUOUS_POSTING_MAX_CLEAR_IDS) throw new RangeError('Selecione de 1 a 1.000 avisos.');
  return { noticeIds, itemIds };
}

export type ContinuousPostingGuardDetail = {
  openItems: number;
  activeHorizons: number;
  eligibleMedia: number;
  eligibleProfiles: number;
};

/** Lê o `detail` da guarda de ligar. Devolve null quando não é o JSON da guarda. */
export function parseContinuousPostingGuardDetail(detail: unknown): ContinuousPostingGuardDetail | null {
  let parsed: unknown = detail;
  if (typeof detail === 'string') {
    try { parsed = JSON.parse(detail); } catch { return null; }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const keys = ['openItems', 'activeHorizons', 'eligibleMedia', 'eligibleProfiles'] as const;
  const out = {} as ContinuousPostingGuardDetail;
  for (const key of keys) {
    const number = Number(record[key]);
    if (record[key] === null || record[key] === undefined || !Number.isFinite(number) || number < 0) return null;
    out[key] = Math.trunc(number);
  }
  return out;
}

/**
 * Frase para quem tentou ligar e foi recusado. Uma recusa pode ter mais de um
 * motivo; todos aparecem, na ordem em que a pessoa consegue resolver.
 */
export function continuousPostingGuardMessage(detail: ContinuousPostingGuardDetail, format: ContinuousPostingFormat) {
  const plural = format === 'reel' ? 'reels' : 'stories';
  const single = format === 'reel' ? 'reel' : 'story';
  const reasons: string[] = [];
  if (detail.openItems > 0) {
    reasons.push(`Este grupo ainda tem ${detail.openItems.toLocaleString('pt-BR')} ${detail.openItems === 1 ? single : plural} na fila. Cancele a fila do grupo antes de ligar.`);
  }
  if (detail.activeHorizons > 0) {
    reasons.push(detail.activeHorizons === 1
      ? `Há 1 reserva ativa de agendamento em massa de ${plural} para perfil deste grupo. Cancele o plano antes de ligar.`
      : `Há ${detail.activeHorizons.toLocaleString('pt-BR')} reservas ativas de agendamento em massa de ${plural} para perfis deste grupo. Cancele os planos antes de ligar.`);
  }
  if (detail.eligibleMedia === 0) {
    reasons.push(format === 'reel'
      ? 'A origem das mídias não tem nenhum vídeo pronto. Envie vídeos para a origem ou escolha outra em Configurar.'
      : 'A origem das mídias não tem nenhuma mídia pronta. Envie mídias para a origem ou escolha outra em Configurar.');
  }
  if (detail.eligibleProfiles === 0) {
    reasons.push('Nenhum perfil deste grupo pode postar agora: é preciso ter perfil conectado pela API oficial da Meta.');
  }
  return reasons.length > 0 ? reasons.join(' ') : 'Não foi possível ligar a postagem contínua deste grupo.';
}

export type ContinuousPostingDatabaseError = {
  code?: string | null;
  message?: string | null;
  /** PostgREST entrega o DETAIL do Postgres em `details`; `detail` fica aceito por garantia. */
  details?: string | null;
  detail?: string | null;
  hint?: string | null;
};

const GENERIC_ERROR = 'Não foi possível concluir a operação da postagem contínua.';

/** Erro do Postgres/PostgREST → status HTTP e mensagem em português para a tela. */
export function continuousPostingErrorResponse(error: ContinuousPostingDatabaseError, format: ContinuousPostingFormat = 'reel') {
  const code = error.code ?? '';
  const message = error.message?.trim() ?? '';
  if (code === 'P0001') {
    const detail = parseContinuousPostingGuardDetail(error.details ?? error.detail);
    if (detail) return { status: 409, message: continuousPostingGuardMessage(detail, format) };
    return { status: 400, message: message || GENERIC_ERROR };
  }
  if (code === '42501') return { status: 403, message: 'Ação não permitida.' };
  if (code === 'P0002' || code === '02000') return { status: 404, message: 'Regra ou grupo não encontrado.' };
  if (code === '23503') return { status: 400, message: 'Grupo ou origem das mídias não encontrado.' };
  if (code === '23505') return { status: 409, message: message || 'Já existe uma regra para este grupo e formato.' };
  if (code === '23514' || code.startsWith('22')) return { status: 400, message: message || 'Configuração inválida.' };
  // Função ausente no banco (migration 443 ainda não aplicada) ou cache de schema velho.
  if (code === 'PGRST202' || code === '42883') return { status: 503, message: 'A postagem contínua ainda não está disponível no banco de dados.' };
  return { status: 500, message: GENERIC_ERROR };
}
