import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { createSupabaseAdminClient } from '../../lib/supabase/admin';

const execFileAsync = promisify(execFile);

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Variável obrigatória ausente: ${name}`);
  return value;
}

async function main() {
  if (required('TWITTER_CANARY_CONFIRM') !== 'create-one-isolated-motion-asset') throw new Error('Confirmação operacional inválida.');
  const organizationId = required('TWITTER_CANARY_ORGANIZATION_ID');
  const kind = required('TWITTER_CANARY_MOTION_KIND') as 'gif' | 'video';
  if (!['gif', 'video'].includes(kind)) throw new Error('Tipo de mídia inválido.');
  const admin = createSupabaseAdminClient();
  const { data: membership } = await admin.from('organization_members').select('user_id,role').eq('organization_id', organizationId).eq('role', 'admin').order('joined_at').limit(1).single();
  if (!membership || membership.role !== 'admin') throw new Error('Admin canário inválido.');

  const tempRoot = path.resolve(os.tmpdir());
  const tempDirectory = await mkdtemp(path.join(tempRoot, 'athena-twitter-canary-'));
  const resolvedTemp = path.resolve(tempDirectory);
  if (!resolvedTemp.startsWith(`${tempRoot}${path.sep}`) || !path.basename(resolvedTemp).startsWith('athena-twitter-canary-')) throw new Error('Diretório temporário inseguro.');
  try {
    const extension = kind === 'gif' ? 'gif' : 'mp4';
    const output = path.join(resolvedTemp, `asset.${extension}`);
    const source = 'testsrc2=size=640x360:rate=12:duration=2';
    const args = kind === 'gif'
      ? ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', source, '-vf', 'fps=12,scale=640:360:flags=lanczos', '-loop', '0', output]
      : ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', source, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', output];
    await execFileAsync('ffmpeg', args, { windowsHide: true, timeout: 60_000 });
    const buffer = await readFile(output);
    if (buffer.byteLength < 1_000 || buffer.byteLength > 10 * 1024 * 1024) throw new Error('Tamanho inesperado do asset de movimento.');
    const id = randomUUID();
    const storagePath = `${organizationId}/assets/${id}.${extension}`;
    const mimeType = kind === 'gif' ? 'image/gif' : 'video/mp4';
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    const stamp = new Date().toISOString().replace(/[:]/g, '-');
    const { error: insertError } = await admin.from('twitter_media_assets').insert({
      id, organization_id: organizationId, storage_path: storagePath,
      original_name: `athena-x-canary-${kind}-${stamp}.${extension}`,
      mime_type: mimeType, media_kind: kind, byte_size: buffer.byteLength,
      width: 640, height: 360, duration_ms: 2000, sha256, created_by: membership.user_id,
    });
    if (insertError) throw new Error(`Falha ao reservar mídia X: ${insertError.message}`);
    const { error: uploadError } = await admin.storage.from('twitter-media').upload(storagePath, buffer, { contentType: mimeType, cacheControl: '3600', upsert: false });
    if (uploadError) {
      await admin.from('twitter_media_assets').update({ status: 'failed', failure_code: 'storage_upload_failed', failure_message: uploadError.message.slice(0, 500) }).eq('id', id);
      throw new Error(`Falha no upload: ${uploadError.message}`);
    }
    const { error: readyError } = await admin.from('twitter_media_assets').update({ status: 'ready' }).eq('id', id);
    if (readyError) throw new Error(`Falha ao concluir mídia X: ${readyError.message}`);
    const { data: signed, error: signedError } = await admin.storage.from('twitter-media').createSignedUrl(storagePath, 300);
    if (signedError || !signed?.signedUrl) throw new Error('Falha ao assinar mídia X.');
    const response = await fetch(signed.signedUrl, { headers: { range: 'bytes=0-63' } });
    if (!response.ok || !(await response.arrayBuffer()).byteLength) throw new Error('Leitura assinada da mídia falhou.');
    process.stdout.write(`${JSON.stringify({ assetId: id, mediaKind: kind, mimeType, byteSize: buffer.byteLength, width: 640, height: 360, durationMs: 2000, sha256, signedReadVerified: true }, null, 2)}\n`);
  } finally {
    await rm(resolvedTemp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Falha desconhecida.'}\n`);
  process.exitCode = 1;
});
