import { notFound, redirect } from "next/navigation";

import { TwitterFinancialRules } from "@/app/x/twitter-financial-rules";
import { TwitterLogsCenter } from "@/app/x/twitter-logs-center";
import { getOrganizationContext } from "@/lib/organizations/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { isTwitterModuleEnabled } from "@/lib/twitter/feature";

export const dynamic = "force-dynamic";

export default async function TwitterLogsPage() {
  const context = await getOrganizationContext();
  if (!context.user) redirect("/login");
  if (!context.activeOrganization) redirect("/onboarding");
  if (!isTwitterModuleEnabled(context.activeOrganization.id)) notFound();
  const admin = createSupabaseAdminClient();
  const [profilesResult, connectionsResult] = await Promise.all([
    admin.from("twitter_profiles").select("id,username,status").eq("organization_id", context.activeOrganization.id).neq("status", "deleted").order("username"),
    admin.from("twitter_connections").select("id,label,status").eq("organization_id", context.activeOrganization.id).neq("status", "deleted").order("label"),
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
