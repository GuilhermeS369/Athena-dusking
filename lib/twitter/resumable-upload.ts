'use client';

import { createSupabaseBrowserClient } from '@/lib/supabase/browser';

const TUS_VERSION = '1.0.0';
const CHUNK_SIZE = 6 * 1024 * 1024;

function metadata(values: Record<string, string>) {
  return Object.entries(values).map(([key, value]) => `${key} ${btoa(value)}`).join(',');
}

function resumeKey(path: string, file: File) {
  return `athena:twitter:tus:${path}:${file.size}:${file.lastModified}`;
}

export async function uploadTwitterMediaResumable(input: {
  file: File;
  storagePath: string;
  onProgress?: (progress: number) => void;
  signal?: AbortSignal;
}) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) throw new Error('Storage não configurado neste deployment.');
  const { data, error } = await createSupabaseBrowserClient().auth.getSession();
  if (error || !data.session) throw new Error('Sessão expirada. Entre novamente.');
  const headers = {
    Authorization: `Bearer ${data.session.access_token}`,
    apikey: anonKey,
    'Tus-Resumable': TUS_VERSION,
  };
  const key = resumeKey(input.storagePath, input.file);
  let uploadUrl = localStorage.getItem(key);
  let offset = 0;

  if (uploadUrl) {
    const head = await fetch(uploadUrl, { method: 'HEAD', headers, signal: input.signal });
    if (head.ok) offset = Number.parseInt(head.headers.get('upload-offset') ?? '0', 10) || 0;
    else { localStorage.removeItem(key); uploadUrl = null; }
  }

  if (!uploadUrl) {
    const created = await fetch(`${supabaseUrl.replace(/\/$/, '')}/storage/v1/upload/resumable`, {
      method: 'POST',
      headers: {
        ...headers,
        'Upload-Length': String(input.file.size),
        'Upload-Metadata': metadata({
          bucketName: 'twitter-media',
          objectName: input.storagePath,
          contentType: input.file.type,
          cacheControl: '3600',
        }),
        'x-upsert': 'false',
      },
      signal: input.signal,
    });
    if (!created.ok) throw new Error(`Storage recusou o início do upload (${created.status}).`);
    const location = created.headers.get('location');
    if (!location) throw new Error('Storage não retornou a localização retomável.');
    uploadUrl = new URL(location, supabaseUrl).toString();
    localStorage.setItem(key, uploadUrl);
  }

  while (offset < input.file.size) {
    const chunk = input.file.slice(offset, Math.min(offset + CHUNK_SIZE, input.file.size));
    const response = await fetch(uploadUrl, {
      method: 'PATCH',
      headers: {
        ...headers,
        'Upload-Offset': String(offset),
        'Content-Type': 'application/offset+octet-stream',
      },
      body: chunk,
      signal: input.signal,
    });
    if (!response.ok) throw new Error(`Upload interrompido pelo Storage (${response.status}).`);
    offset = Number.parseInt(response.headers.get('upload-offset') ?? '', 10);
    if (!Number.isFinite(offset)) throw new Error('Storage retornou offset inválido.');
    input.onProgress?.(offset / input.file.size);
  }
  localStorage.removeItem(key);
}
