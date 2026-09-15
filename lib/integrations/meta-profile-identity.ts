/**
 * Identidade de um perfil Meta (username, nome, foto) e como decidir se o que a
 * Meta devolveu em `GET /me` difere do que está gravado.
 *
 * Usado pela coleta de métricas (que já pede `me` em todo perfil online e
 * antes descartava o username), pelo script de passada completa
 * `scripts/workers/meta-identity-refresh-worker.ts` e pelo botão Sincronizar.
 * A decisão final de escrever é da RPC `refresh_instagram_profile_identity`
 * (migration 429), que repete estas mesmas regras em SQL; aqui a comparação
 * serve para não chamar a RPC 2.200 vezes por rodada quando nada mudou.
 */

export type StoredMetaProfileIdentity = {
  username: string | null;
  display_name: string | null;
  profile_picture_url: string | null;
};

export type MetaProfileIdentity = {
  username: string | null;
  displayName: string | null;
  profilePictureUrl: string | null;
};

export type MetaProfileIdentityDiff = {
  username: boolean;
  displayName: boolean;
  picture: boolean;
};

export function normalizeInstagramUsername(value: string | null | undefined) {
  const trimmed = (value ?? '').trim().replace(/^@/, '').trim();
  return trimmed ? trimmed.toLowerCase() : null;
}

/**
 * A Meta troca host e assinatura da URL da foto a cada chamada
 * (`_nc_ohc`, `oh`, `oe`...); o nome do arquivo no CDN é o que identifica a
 * imagem. Mesma regra da função SQL `instagram_picture_key`.
 */
export function instagramPictureKey(url: string | null | undefined) {
  const match = /\/([^/?]+\.(?:jpg|jpeg|png|webp))(?:\?|$)/i.exec(url ?? '');
  return match ? match[1] : null;
}

/** Lê os campos de identidade de uma resposta `me` da Graph API. */
export function metaProfileIdentityFromAccount(body: Record<string, unknown>): MetaProfileIdentity | null {
  const username = typeof body.username === 'string' ? body.username : null;
  if (!normalizeInstagramUsername(username)) return null;
  return {
    username,
    displayName: typeof body.name === 'string' ? body.name : null,
    profilePictureUrl: typeof body.profile_picture_url === 'string' ? body.profile_picture_url : null,
  };
}

export function metaProfileIdentityChanged(
  stored: StoredMetaProfileIdentity,
  fromMeta: MetaProfileIdentity,
): MetaProfileIdentityDiff {
  const newUsername = normalizeInstagramUsername(fromMeta.username);
  const newDisplayName = fromMeta.displayName?.trim() || null;
  const newPicture = instagramPictureKey(fromMeta.profilePictureUrl);
  return {
    username: newUsername !== null && newUsername !== normalizeInstagramUsername(stored.username),
    // Nome nulo vindo da Meta não apaga o que temos.
    displayName: newDisplayName !== null && newDisplayName !== (stored.display_name?.trim() || null),
    picture: newPicture !== null && newPicture !== instagramPictureKey(stored.profile_picture_url),
  };
}

export function hasMetaProfileIdentityChange(diff: MetaProfileIdentityDiff) {
  return diff.username || diff.displayName || diff.picture;
}
