import { NextResponse } from "next/server";
import { cookies } from "next/headers";

import {
  ACTIVE_ORGANIZATION_COOKIE,
  type Organization,
  type OrganizationRole,
} from "@/lib/organizations/server";
import { isSystemSuperUser } from "@/lib/security/super-user";
import { createSupabaseServerClient } from "@/lib/supabase/server";

type InstagramOperationContextRow = {
  userId: string;
  email: string | null;
  activeOrganization: Organization;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function getInstagramOperationContext(requiredRole?: "operator" | "admin") {
  const cookieStore = await cookies();
  const requestedOrganizationId = cookieStore.get(ACTIVE_ORGANIZATION_COOKIE)?.value;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_instagram_operation_context", {
    p_requested_organization_id: requestedOrganizationId && UUID_PATTERN.test(requestedOrganizationId)
      ? requestedOrganizationId
      : null,
  });

  if (error) {
    console.error("[instagram-observability] request context failed", {
      code: error.code,
      message: error.message,
    });
    return { response: NextResponse.json({ error: "Não foi possível validar o acesso." }, { status: 500 }) } as const;
  }

  const resolved = data as InstagramOperationContextRow | null;
  if (!resolved?.userId || !resolved.activeOrganization) {
    return { response: NextResponse.json({ error: "Não autenticado." }, { status: 401 }) } as const;
  }
  const roles = requiredRole === "admin" ? ["admin"] : requiredRole === "operator"
    ? ["admin", "operator"] : ["admin", "operator", "viewer"];
  if (!roles.includes(resolved.activeOrganization.role)) {
    return { response: NextResponse.json({ error: "Ação não permitida." }, { status: 403 }) } as const;
  }

  const activeOrganization = {
    ...resolved.activeOrganization,
    role: resolved.activeOrganization.role as OrganizationRole,
  };
  const user = { id: resolved.userId, email: resolved.email ?? undefined };

  return {
    context: {
      user,
      organizations: [activeOrganization],
      activeOrganization,
      isSuperUser: isSystemSuperUser(user.email),
    },
  } as const;
}
