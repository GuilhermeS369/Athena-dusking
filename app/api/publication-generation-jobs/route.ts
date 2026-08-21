import { NextResponse } from 'next/server';

import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const managerRoles = new Set(['admin', 'operator']);
const maximumListLimit = 50;
const maximumExpectedItems = 1_000_000;

function parseDate(value: unknown) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') return undefined;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? undefined : date.toISOString();
}

function integerBodyValue(value: unknown, fallback: number, minimum: number, maximum: number) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, minimum), maximum);
}

function canManage(role: string | undefined) {
  return Boolean(role && managerRoles.has(role));
}

export async function GET(request: Request) {
  const context = await getOrganizationContext();
  if (!context.user || !context.activeOrganization) {
    return NextResponse.json({ error: 'Autenticação necessária.' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const requestedLimit = Number.parseInt(searchParams.get('limit') ?? '', 10);
  const limit = Number.isInteger(requestedLimit) && requestedLimit > 0
    ? Math.min(requestedLimit, maximumListLimit)
    : 20;
  const status = searchParams.get('status');

  const supabase = await createSupabaseServerClient();
  let query = supabase
    .from('publication_generation_jobs')
    .select('id, name, status, scheduled_for, expected_items, generated_items, failed_items, chunk_size, chunk_count, attempt_count, last_error_message, created_at, updated_at, completed_at, metadata')
    .eq('organization_id', context.activeOrganization.id)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (status) query = query.eq('status', status);

  const { data, error } = await query;
  if (error) {
    console.error('Não foi possível listar jobs de geração.', error);
    return NextResponse.json({ error: 'Não foi possível listar jobs de geração.' }, { status: 500 });
  }

  return NextResponse.json({ jobs: data ?? [] });
}

export async function POST(request: Request) {
  const context = await getOrganizationContext();
  const organization = context.organizations.find((item) => item.id === context.activeOrganization?.id);

  if (!context.user || !context.activeOrganization) {
    return NextResponse.json({ error: 'Autenticação necessária.' }, { status: 401 });
  }
  if (!canManage(organization?.role)) {
    return NextResponse.json({ error: 'Ação não permitida.' }, { status: 403 });
  }

  let body: {
    name?: unknown;
    scheduledFor?: unknown;
    payload?: unknown;
    plan?: unknown;
    expectedItems?: unknown;
    chunkSize?: unknown;
    metadata?: unknown;
  };
  try {
    body = await request.json() as typeof body;
  } catch {
    return NextResponse.json({ error: 'Corpo da requisição inválido.' }, { status: 400 });
  }

  const scheduledFor = parseDate(body.scheduledFor);
  if (scheduledFor === undefined) {
    return NextResponse.json({ error: 'A data de referência do job é inválida.' }, { status: 400 });
  }

  const payload = body.payload ?? body.plan;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return NextResponse.json({ error: 'Informe um payload de geração em formato de objeto.' }, { status: 400 });
  }

  const inferredExpectedItems = Array.isArray((payload as { items?: unknown }).items)
    ? (payload as { items: unknown[] }).items.length
    : undefined;
  const expectedItems = integerBodyValue(body.expectedItems, inferredExpectedItems ?? 1, 1, maximumExpectedItems);
  const chunkSize = integerBodyValue(body.chunkSize, 500, 1, 1000);
  const metadata = body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
    ? body.metadata
    : {};

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('create_publication_generation_job', {
    p_organization_id: context.activeOrganization.id,
    p_name: typeof body.name === 'string' ? body.name : null,
    p_scheduled_for: scheduledFor,
    p_payload: payload,
    p_expected_items: expectedItems,
    p_chunk_size: chunkSize,
    p_metadata: {
      source: 'publication-generation-jobs-api',
      createdByEmail: context.user.email ?? null,
      ...metadata,
    },
  });

  if (error || !data) {
    console.error('Não foi possível criar job de geração.', error);
    return NextResponse.json({ error: 'Não foi possível criar job de geração.' }, { status: 500 });
  }

  return NextResponse.json(data, { status: 201 });
}
