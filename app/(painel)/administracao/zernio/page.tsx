import Link from "next/link";
import { redirect } from "next/navigation";

import ZernioGlobalRemovalButton from "@/app/(painel)/operacao/quedas-zernio/zernio-global-removal-button";
import { getOrganizationContext } from "@/lib/organizations/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

import styles from "./zernio-administration.module.css";

export const dynamic = "force-dynamic";

type EligibleIncident = {
  id: string; username_snapshot: string; retained_zernio_account_id: string | null;
  retained_connection_label_snapshot: string | null; removed_connection_label_snapshot: string | null;
  state: string; detected_at: string;
};

export default async function ZernioAdministrationPage() {
  const context = await getOrganizationContext();
  if (!context.user) redirect("/login");
  if (!context.activeOrganization) redirect("/onboarding");
  if (context.activeOrganization.role !== "admin") redirect("/operacao?scope=connection");
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin.from("zernio_profile_disconnection_incidents")
    .select("id,username_snapshot,retained_zernio_account_id,retained_connection_label_snapshot,removed_connection_label_snapshot,state,detected_at")
    .eq("organization_id", context.activeOrganization.id).eq("signal", "duplicate_identity_auto_removed")
    .in("state", ["deferred", "retry_scheduled", "remote_removal_pending"])
    .order("detected_at", { ascending: false }).limit(100);
  if (error) throw new Error("Não foi possível carregar os diagnósticos Zernio.");
  const incidents = (data ?? []) as EligibleIncident[];
  return <main className={styles.shell}>
    <header><div><span>Administração protegida</span><h1>Remoções globais Zernio</h1><p>Esta área não faz parte dos logs. Ela executa apenas casos diagnosticados como account ID compartilhado entre duas chaves.</p></div><Link href="/operacao?scope=connection">← Voltar aos logs</Link></header>
    <section className={styles.warning}><strong>O DELETE é global.</strong><p>Antes de liberar o botão, o servidor consulta as duas chaves, confirma identidade, account ID e estado atual. A confirmação digitada continua obrigatória e uma divergência cancela toda a ação.</p></section>
    <section className={styles.list}>{incidents.length ? incidents.map((incident) => <article key={incident.id}><div><span>@{incident.username_snapshot}</span><strong>{incident.retained_zernio_account_id}</strong><small>{incident.retained_connection_label_snapshot ?? "Chave preservada"} ↔ {incident.removed_connection_label_snapshot ?? "Chave excedente"}</small></div><div><small>{incident.state.replaceAll("_", " ")}</small>{incident.retained_zernio_account_id && <ZernioGlobalRemovalButton incidentId={incident.id} username={incident.username_snapshot} accountId={incident.retained_zernio_account_id} retainedConnectionLabel={incident.retained_connection_label_snapshot ?? "Chave preservada"} removedConnectionLabel={incident.removed_connection_label_snapshot ?? "Chave excedente"} />}</div></article>) : <div className={styles.empty}><strong>Nenhuma remoção global elegível</strong><p>Isso é bom: não há duplicidade aguardando uma decisão destrutiva.</p></div>}</section>
  </main>;
}
