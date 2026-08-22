import { createHash, randomUUID } from 'node:crypto';

import sharp from 'sharp';

import { createSupabaseAdminClient } from '../../lib/supabase/admin';

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Variável obrigatória ausente: ${name}`);
  return value;
}

async function main() {
  if (required('TWITTER_CANARY_CONFIRM') !== 'create-one-isolated-image') throw new Error('Confirmação operacional inválida.');
  const organizationId = required('TWITTER_CANARY_ORGANIZATION_ID');
  const admin = createSupabaseAdminClient();
  const [{ data: organization }, { data: membership }] = await Promise.all([
    admin.from('organizations').select('name').eq('id', organizationId).is('deleted_at', null).single(),
    admin.from('organization_members').select('user_id, role').eq('organization_id', organizationId).eq('role', 'admin').order('joined_at').limit(1).single(),
  ]);
  if (!organization || !membership || membership.role !== 'admin') throw new Error('Organização/admin canário inválido.');

  const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const svg = Buffer.from(`<svg width="1200" height="675" xmlns="http://www.w3.org/2000/svg">
    <rect width="1200" height="675" fill="#10131a"/>
    <rect x="56" y="56" width="1088" height="563" rx="36" fill="#181d28" stroke="#6f7cff" stroke-width="4"/>
    <text x="100" y="250" fill="#ffffff" font-family="Arial, sans-serif" font-size="72" font-weight="700">Athena · Canário X</text>
    <text x="100" y="350" fill="#b9c0ff" font-family="Arial, sans-serif" font-size="40">Publicação isolada com 1 imagem</text>
    <text x="100" y="455" fill="#9099aa" font-family="Arial, sans-serif" font-size="28">${stamp}</text>
  </svg>`);
  const buffer = await sharp(svg).png({ compressionLevel: 9 }).toBuffer();
  const id = randomUUID();
  const storagePath = `${organizationId}/assets/${id}.png`;
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  const { error: insertError } = await admin.from('twitter_media_assets').insert({
    id,
    organization_id: organizationId,
    storage_path: storagePath,
    original_name: `athena-x-canary-${stamp.replace(/[:]/g, '-')}.png`,
    mime_type: 'image/png',
    media_kind: 'image',
    byte_size: buffer.byteLength,
    width: 1200,
    height: 675,
    sha256,
    created_by: membership.user_id,
  });
  if (insertError) throw new Error(`Falha ao reservar asset X: ${insertError.message}`);
  const { error: uploadError } = await admin.storage.from('twitter-media').upload(storagePath, buffer, {
    contentType: 'image/png', cacheControl: '3600', upsert: false,
  });
  if (uploadError) {
    await admin.from('twitter_media_assets').update({ status: 'failed', failure_code: 'storage_upload_failed', failure_message: uploadError.message.slice(0, 500) }).eq('id', id);
    throw new Error(`Falha no upload isolado: ${uploadError.message}`);
  }
  const { error: readyError } = await admin.from('twitter_media_assets').update({ status: 'ready' }).eq('id', id).eq('organization_id', organizationId);
  if (readyError) throw new Error(`Falha ao concluir asset X: ${readyError.message}`);
  const { data: signed, error: signedError } = await admin.storage.from('twitter-media').createSignedUrl(storagePath, 300);
  if (signedError || !signed?.signedUrl) throw new Error('Asset criado, mas a assinatura de leitura falhou.');
  const response = await fetch(signed.signedUrl, { method: 'GET', headers: { range: 'bytes=0-31' } });
  if (!response.ok || !(await response.arrayBuffer()).byteLength) throw new Error('URL assinada do asset não pôde ser lida.');
  process.stdout.write(`${JSON.stringify({ assetId: id, mediaKind: 'image', mimeType: 'image/png', byteSize: buffer.byteLength, width: 1200, height: 675, sha256, signedReadVerified: true }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Falha desconhecida.'}\n`);
  process.exitCode = 1;
});
