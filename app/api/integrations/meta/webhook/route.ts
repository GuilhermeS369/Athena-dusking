import { NextResponse } from 'next/server';

import { loadMetaAppSigners } from '@/lib/integrations/meta-app-signers';
import { findMetaWebhookSigner, summarizeMetaWebhook, verifyMetaWebhookToken } from '@/lib/integrations/meta-webhook';

export const dynamic = 'force-dynamic';

/**
 * Handshake de verificação. A Meta chama esta URL com `hub.mode=subscribe` e
 * espera o `hub.challenge` devolvido em texto puro, com 200. Qualquer outra
 * resposta reprova o "Verificar e salvar" do painel.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const challenge = params.get('hub.challenge');

  if (
    params.get('hub.mode') !== 'subscribe'
    || !challenge
    || !verifyMetaWebhookToken(params.get('hub.verify_token'))
  ) {
    console.warn('[meta-webhook] verification_rejected', {
      mode: params.get('hub.mode'),
      hasChallenge: Boolean(challenge),
    });

    return new NextResponse('Forbidden', { status: 403 });
  }

  return new NextResponse(challenge, {
    status: 200,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}

/**
 * Recebimento dos eventos. Hoje a assinatura é validada e o formato do evento
 * é registrado; nenhuma tabela consome esses eventos ainda, então a resposta é
 * sempre rápida — a Meta desativa a inscrição quando o endpoint demora ou falha
 * de forma repetida.
 */
export async function POST(request: Request) {
  const raw = await request.text();
  const signer = findMetaWebhookSigner(
    raw,
    request.headers.get('x-hub-signature-256'),
    await loadMetaAppSigners(),
  );

  if (!signer) {
    console.warn('[meta-webhook] invalid_signature', { bytes: raw.length });
    return NextResponse.json({ error: 'Assinatura inválida.' }, { status: 401 });
  }

  const summary = summarizeMetaWebhook(raw);

  if (!summary) {
    console.warn('[meta-webhook] unparsable_payload', { appId: signer.appId, bytes: raw.length });
    return NextResponse.json({ error: 'Payload inválido.' }, { status: 400 });
  }

  console.info('[meta-webhook] received', { appId: signer.appId, ...summary });

  return NextResponse.json({ received: true });
}
