'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

import { uploadTwitterMediaResumable } from '@/lib/twitter/resumable-upload';
import { validateTwitterMedia } from '@/lib/twitter/media';

type Asset = { id: string; original_name: string; mime_type: string; media_kind: string; byte_size: number; signedUrl: string | null };

export default function TwitterGalleryClient({ assets, canEdit }: { assets: Asset[]; canEdit: boolean }) {
  const router = useRouter(); const input = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<number | null>(null); const [message, setMessage] = useState<string | null>(null);
  async function upload(file: File) {
    const validation = validateTwitterMedia(file); if (!validation.valid) { setMessage(validation.error); return; }
    setProgress(0); setMessage(null);
    try {
      const init = await fetch('/api/x/media', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: file.name, mimeType: file.type, size: file.size }) });
      const body = await init.json() as { assetId?: string; storagePath?: string; error?: string };
      if (!init.ok || !body.assetId || !body.storagePath) throw new Error(body.error ?? 'Não foi possível reservar o upload.');
      await uploadTwitterMediaResumable({ file, storagePath: body.storagePath, onProgress: setProgress });
      const complete = await fetch(`/api/x/media/${body.assetId}/complete`, { method: 'POST' });
      const completed = await complete.json() as { error?: string };
      if (!complete.ok) throw new Error(completed.error ?? 'Não foi possível concluir o upload.');
      setMessage('Mídia enviada para a galeria X.'); router.refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Falha no upload.'); }
    finally { setProgress(null); if (input.current) input.current.value = ''; }
  }
  async function remove(id: string) { if (!confirm('Remover esta mídia da galeria X?')) return; await fetch(`/api/x/media/${id}`, { method: 'DELETE' }); router.refresh(); }
  return <div className="content-stack">{message ? <div className="notice-banner">{message}</div> : null}{canEdit ? <div className="panel"><input ref={input} type="file" accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/quicktime" onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file); }} disabled={progress !== null} />{progress !== null ? <p>Upload retomável: {Math.round(progress * 100)}%</p> : <p className="muted">Até 512 MB. O navegador envia em blocos diretamente ao Storage.</p>}</div> : null}<section className="media-grid">{assets.length === 0 ? <div className="empty-state"><h2>Galeria X vazia</h2></div> : assets.map((asset) => <article className="media-card" key={asset.id}>{asset.signedUrl && asset.media_kind !== 'video' ? <img src={asset.signedUrl} alt={asset.original_name} /> : <div className="empty-state-icon">{asset.media_kind === 'video' ? '▶' : 'X'}</div>}<div className="media-card-body"><strong>{asset.original_name}</strong><span>{(asset.byte_size / 1024 / 1024).toFixed(1)} MB</span>{canEdit ? <button className="button button-danger" onClick={() => void remove(asset.id)}>Remover</button> : null}</div></article>)}</section></div>;
}
