import { createSupabaseAdminClient } from '@/lib/supabase/admin';

export type ZernioSlotReservation = {
  reservation_id: string;
  zernio_connection_id: string;
  connection_label: string;
  used_slots: number;
  slot_limit: number;
  fallback_used: boolean;
};

export async function reserveZernioConnectionSlot(input: {
  organizationId: string;
  requestedConnectionId: string;
  reservedBy: string;
  leaseSeconds?: number;
}) {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase.rpc('reserve_zernio_connection_slot', {
    p_organization_id: input.organizationId,
    p_requested_connection_id: input.requestedConnectionId,
    p_reserved_by: input.reservedBy,
    p_lease_seconds: input.leaseSeconds ?? 720,
  });
  if (error) throw error;
  const reservation = (data ?? [])[0] as ZernioSlotReservation | undefined;
  if (!reservation?.reservation_id || !reservation.zernio_connection_id) {
    throw new Error('A reserva de slot Zernio não retornou uma conta válida.');
  }
  return reservation;
}

export async function releaseZernioConnectionSlotReservation(input: {
  organizationId: string;
  reservationId: string | null | undefined;
  reason: string;
}) {
  if (!input.reservationId) return false;
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase.rpc('release_zernio_connection_slot_reservation', {
    p_reservation_id: input.reservationId,
    p_organization_id: input.organizationId,
    p_reason: input.reason,
  });
  if (error) throw error;
  return Boolean(data);
}
