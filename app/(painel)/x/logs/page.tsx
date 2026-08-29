import { notFound, redirect } from "next/navigation";

import { TwitterFinancialRules } from "@/app/x/twitter-financial-rules";
import { TwitterLogsCenter } from "@/app/x/twitter-logs-center";
import { getOrganizationContext } from "@/lib/organizations/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { isTwitterModuleEnabled } from "@/lib/twitter/feature";

export const dynamic = "force-dynamic";

export default async function TwitterLogsPage() {
  const context = await getOrganizationContext();
  if (!context.user) redirect("/login");
  if (!context.activeOrganization) redirect("/onboarding");
  if (!isTwitterModuleEnabled(context.activeOrganization.id)) notFound();
  const admin = createSupabaseAdminClient();
  // Fixado fora dos callbacks: dentro deles o TypeScript perde o estreitamento
  // de activeOrganization feito no guard acima.
  const organizationId = context.activeOrganization.id;
  const [profilesResult, connectionsResult] = await Promise.all([
    fetchAllRows((from, to) => admin.from("twitter_profiles").select("id,username,status").eq("organization_id", organizationId).neq("status", "deleted").order("username").order("id").range(from, to)),
    fetchAllRows((from, to) => admin.from("twitter_connections").select("id,label,status").eq("organization_id", organizationId).neq("status", "deleted").order("label").order("id").range(from, to)),
  ]);
  if (profilesResult.error || connectionsResult.error) throw new Error("Não foi possível preparar os filtros dos logs X.");
  return (
    <main className="standalone-page twitter-logs-page">
      <header className="standalone-header twitter-logs-header">
        <div>
          <span className="section-kicker">{context.activeOrganization.name} · X / Twitter</span>
          <h1>Centro de observabilidade</h1>
          <p>Incidentes agrupados, quedas de contas, filas, workers e evidências operacionais sem apagar o histórico.</p>
        </div>
      </header>
      <TwitterLogsCenter role={context.activeOrganization.role} profiles={profilesResult.data ?? []} connections={connectionsResult.data ?? []} />
      {context.activeOrganization.role === "admin" ? <details className="panel twitter-financial-settings"><summary>Configuração das regras financeiras do X</summary><TwitterFinancialRules /></details> : null}
    </main>
  );
}
