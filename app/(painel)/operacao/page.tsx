import { redirect } from "next/navigation";
import { Suspense } from "react";

import PageLoadingSkeleton from "@/app/components/page-loading-skeleton";
import InstagramObservabilityCenter from "@/app/operacao/instagram-observability-center";
import { getOrganizationContext } from "@/lib/organizations/server";
import { isSystemSuperUser } from "@/lib/security/super-user";

export const dynamic = "force-dynamic";

export default function OperationPage() {
  return <Suspense fallback={<PageLoadingSkeleton variant="logs" />}><OperationContent /></Suspense>;
}

async function OperationContent() {
  const context = await getOrganizationContext();
  if (!context.user) redirect("/login");
  if (!context.activeOrganization) redirect("/onboarding");
  return <InstagramObservabilityCenter
    organizationName={context.activeOrganization.name}
    role={context.activeOrganization.role}
    isSuperUser={isSystemSuperUser(context.user.email)}
  />;
}
