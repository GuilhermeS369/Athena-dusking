import { createHash, randomBytes } from 'node:crypto';

export type AuthMirrorLinkState = {
  active: boolean;
  activatedAt: string | null;
  createdByEmail: string | null;
  lastUsedAt: string | null;
  useCount: number;
};

export type AuthMirrorLinkRow = {
  active: boolean | null;
  activated_at: string | null;
  created_by_email: string | null;
  last_used_at: string | null;
  use_count: number | null;
};

export const emptyAuthMirrorLinkState: AuthMirrorLinkState = {
  active: false,
  activatedAt: null,
  createdByEmail: null,
  lastUsedAt: null,
  useCount: 0,
};

export function generateAuthMirrorToken() {
  return randomBytes(32).toString('base64url');
}

export function hashAuthMirrorToken(token: string) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function authMirrorLinkStateFromRow(row: AuthMirrorLinkRow | null | undefined): AuthMirrorLinkState {
  if (!row?.active) return emptyAuthMirrorLinkState;

  return {
    active: true,
    activatedAt: row.activated_at ?? null,
    createdByEmail: row.created_by_email ?? null,
    lastUsedAt: row.last_used_at ?? null,
    useCount: row.use_count ?? 0,
  };
}

export function buildAuthMirrorUrl(requestUrl: string, token: string) {
  return new URL(`/auth/espelho/${encodeURIComponent(token)}`, requestUrl).toString();
}

export function isValidAuthMirrorToken(token: string) {
  return /^[A-Za-z0-9_-]{32,160}$/.test(token);
}
