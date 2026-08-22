export const TWITTER_MEDIA_MAX_BYTES = 512 * 1024 * 1024;
export const TWITTER_MEDIA_MIME_TYPES = [
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/quicktime',
] as const;

export type TwitterMediaKind = 'image' | 'gif' | 'video';

export function twitterMediaKind(mimeType: string): TwitterMediaKind | null {
  if (mimeType === 'image/gif') return 'gif';
  if (['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)) return 'image';
  if (['video/mp4', 'video/quicktime'].includes(mimeType)) return 'video';
  return null;
}

export function validateTwitterMedia(file: { type: string; size: number }) {
  const kind = twitterMediaKind(file.type);
  if (!kind) return { valid: false as const, error: 'Use JPEG, PNG, WebP, GIF, MP4 ou MOV.' };
  if (!Number.isInteger(file.size) || file.size < 1 || file.size > TWITTER_MEDIA_MAX_BYTES) {
    return { valid: false as const, error: 'O arquivo deve ter até 512 MB.' };
  }
  return { valid: true as const, kind };
}
