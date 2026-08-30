import type { SupabaseClient } from '@supabase/supabase-js';
import { createR2SignedUrl, deleteFromR2, uploadToR2 } from '@/lib/storage/r2-client';

// Função, não constante: lida em cada chamada, nunca no import do módulo —
// evita depender da ordem entre carregar variáveis de ambiente e importar
// este arquivo (ver mesmo padrão em scripts/workers/publication-direct-dispatch.mjs).
export function mediaStorageBackend() {
  return (process.env.MEDIA_STORAGE_BACKEND || 'supabase').toLowerCase();
}
export function r2InstagramBucket() {
  return process.env.R2_BUCKET_INSTAGRAM_MEDIA || 'instagram-media';
}

type SignedUrlTransform = { width: number; height: number; resize?: 'cover' | 'contain' | 'fill'; quality?: number; format?: 'origin' };

// Mesma forma de retorno do `createSignedUrl` do supabase-js ({ data, error }),
// para que os call sites troquem só a chamada e mantenham `.data?.signedUrl`.
// R2 não tem transformação de imagem embutida como o Supabase Storage — nesse
// backend a transformação é ignorada e a URL da imagem original é devolvida
// (o layout já define width/height no <img>, então o navegador redimensiona).
export async function signMediaPreviewUrl(
  supabase: SupabaseClient,
  storagePath: string,
  expiresInSeconds: number,
  _transform?: SignedUrlTransform,
): Promise<{ data: { signedUrl: string } | null; error: { message: string } | null }> {
  if (mediaStorageBackend() === 'r2') {
    try {
      const signedUrl = await createR2SignedUrl(r2InstagramBucket(), storagePath, expiresInSeconds);
      return { data: { signedUrl }, error: null };
    } catch (error) {
      return { data: null, error: { message: error instanceof Error ? error.message : 'erro desconhecido ao assinar URL no R2' } };
    }
  }
  return supabase.storage.from('instagram-media').createSignedUrl(storagePath, expiresInSeconds, _transform ? { transform: _transform } : undefined);
}

export async function removeMediaObjects(supabase: SupabaseClient, storagePaths: string[]): Promise<{ error: { message: string } | null }> {
  if (!storagePaths.length) return { error: null };
  if (mediaStorageBackend() === 'r2') {
    try {
      await deleteFromR2(r2InstagramBucket(), storagePaths);
      return { error: null };
    } catch (error) {
      return { error: { message: error instanceof Error ? error.message : 'erro desconhecido ao remover do R2' } };
    }
  }
  return supabase.storage.from('instagram-media').remove(storagePaths);
}

// Exclusão real de arquivos: tenta apagar dos DOIS backends, não só do ativo.
// A migração em lote copiou todo o histórico para o R2 sem apagar os
// originais do Supabase — sem isso, excluir uma mídia deixaria uma cópia
// órfã no backend que não está mais em uso no momento da exclusão.
export async function removeMediaObjectsEverywhere(supabase: SupabaseClient, storagePaths: string[]): Promise<{ error: { message: string } | null }> {
  if (!storagePaths.length) return { error: null };
  const [supabaseResult, r2Result] = await Promise.all([
    supabase.storage.from('instagram-media').remove(storagePaths).then((r) => r.error, (error: unknown) => ({ message: error instanceof Error ? error.message : 'erro desconhecido' })),
    deleteFromR2(r2InstagramBucket(), storagePaths).then(() => null, (error: unknown) => ({ message: error instanceof Error ? error.message : 'erro desconhecido' })),
  ]);
  const error = supabaseResult || r2Result;
  return { error: error ? { message: [supabaseResult?.message, r2Result?.message].filter(Boolean).join(' | ') } : null };
}

export async function uploadMediaObject(
  supabase: SupabaseClient,
  storagePath: string,
  body: Buffer,
  contentType: string,
  upsert = false,
): Promise<{ error: { message: string } | null }> {
  if (mediaStorageBackend() === 'r2') {
    try {
      await uploadToR2(r2InstagramBucket(), storagePath, body, contentType);
      return { error: null };
    } catch (error) {
      return { error: { message: error instanceof Error ? error.message : 'erro desconhecido ao enviar para o R2' } };
    }
  }
  const { error } = await supabase.storage.from('instagram-media').upload(storagePath, body, { contentType, upsert });
  return { error };
}

// Valor gravado em `media_assets.storage_backend` (migration 332): normaliza a
// variável de ambiente para os dois valores aceitos pelo check da tabela, que é
// o que a galeria usa para saber que o arquivo está no R2 e não no Supabase.
export function mediaStorageBackendColumn(): 'supabase' | 'r2' {
  return mediaStorageBackend() === 'r2' ? 'r2' : 'supabase';
}
