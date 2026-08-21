import { NextResponse } from 'next/server';

import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

const managerRoles = new Set(['admin', 'operator']);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function canManage(role: string | undefined) {
  return Boolean(role && managerRoles.has(role));
}

export async function GET(_request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const context = await getOrganizationContext();
  const { jobId } = await params;

  if (!context.user || !context.activeOrganization) {
    return NextResponse.json({ error: 'Autenticação necessária.' }, { status: 401 });
  }
  if (!uuidPattern.test(jobId)) {
    return NextResponse.json({ error: 'Job inválido.' }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();
  const [{ data: job, error: jobError }, { data: chunks, error: chunksError }, { data: events, error: eventsError }] = await Promise.all([
    supabase
      .from('publication_generation_jobs')
      .select('id, organization_id, name, status, scheduled_for, payload, expected_items, generated_items, failed_items, chunk_size, chunk_count, attempt_count, claimed_by, lease_until, last_error_message, metadata, created_at, updated_at, completed_at')
      .eq('id', jobId)
      .eq('organization_id', context.activeOrganization.id)
      .maybeSingle(),
    supabase
      .from('publication_generation_job_chunks')
      .select('id, chunk_index, status, expected_items, generated_items, failed_items, attempt_count, claimed_by, lease_until, last_error_message, created_at, updated_at, completed_at')
      .eq('job_id', jobId)
      .eq('organization_id', context.activeOrganization.id)
      .order('chunk_index', { ascending: true })
      .limit(100),
    supabase
      .from('publication_generation_job_events')
      .select('id, chunk_id, event_type, previous_status, status, actor_label, message, metadata, created_at')
      .eq('job_id', jobId)
      .eq('organization_id', context.activeOrganization.id)
      .order('created_at', { ascending: false })
      .limit(100),
  ]);

  if (jobError) return NextResponse.json({ error: 'Não foi possível carregar o job.' }, { status: 500 });
  if (!job) return NextResponse.json({ error: 'Job não encontrado.' }, { status: 404 });
  if (chunksError || eventsError) {
    return NextResponse.json({ error: 'Não foi possível carregar detalhes do job.' }, { status: 500 });
  }

  return NextResponse.json({ job, chunks: chunks ?? [], events: events ?? [] });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const context = await getOrganizationContext();
  const { jobId } = await params;
  const role = context.organizations.find((organization) => organization.id === context.activeOrganization?.id)?.role;

  if (!context.user || !context.activeOrganization) {
    return NextResponse.json({ error: 'Autenticação necessária.' }, { status: 401 });
  }
  if (!canManage(role)) {
    return NextResponse.json({ error: 'Ação não permitida.' }, { status: 403 });
  }
  if (!uuidPattern.test(jobId)) {
    return NextResponse.json({ error: 'Job inválido.' }, { status: 400 });
  }

  let action: unknown;
  try {
    ({ action } = await request.json() as { action?: unknown });
  } catch {
    return NextResponse.json({ error: 'Requisição inválida.' }, { status: 400 });
  }

  if (action !== 'cancel') {
    return NextResponse.json({ error: 'Ação de job inválida.' }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('cancel_publication_generation_job', {
    p_job_id: jobId,
    p_actor_label: context.user.email ?? null,
  });

  if (error) {
    if (error.code === 'P0002') return NextResponse.json({ error: 'Job não encontrado.' }, { status: 404 });
    if (error.code === '42501') return NextResponse.json({ error: 'Ação não permitida.' }, { status: 403 });
    if (error.code === '23514') return NextResponse.json({ error: error.message || 'Este job não pode mais ser cancelado.' }, { status: 409 });
    console.error('Não foi possível cancelar job de geração.', error);
    return NextResponse.json({ error: 'Não foi possível cancelar o job.' }, { status: 500 });
  }

  return NextResponse.json(data);
}
