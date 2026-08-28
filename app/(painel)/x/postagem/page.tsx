import { notFound, redirect } from "next/navigation";
import TwitterBulkClient from "@/app/x/twitter-bulk-client";
import { getOrganizationContext } from "@/lib/organizations/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { isTwitterModuleEnabled } from "@/lib/twitter/feature";

export const dynamic = "force-dynamic";

export default async function TwitterPostPage() {
  const context = await getOrganizationContext();
  if (!context.user) redirect("/login");
  if (!context.activeOrganization) redirect("/onboarding");
  if (!isTwitterModuleEnabled(context.activeOrganization.id)) notFound();
  // Permission contract covered by navigation-permissions: role==='viewer'
  if (context.activeOrganization.role === "viewer") {
    return (
      <main className="standalone-page">
        <section className="panel empty-state">
          <h2>Somente leitura</h2>
          <p>
            Operadores e administradores podem revisar e confirmar programas X.
          </p>
        </section>
      </main>
    );
  }
  const admin = createSupabaseAdminClient();
  const organizationId = context.activeOrganization.id;
  const [
    profilesResult,
    assetsResult,
    groupsResult,
    membershipsResult,
    mediaMembershipsResult,
    queueResult,
  ] = await Promise.all([
    admin
      .from("twitter_profiles")
      .select(
        "id,username,display_name,avatar_url,account_tier,current_connection_id",
      )
      .eq("organization_id", organizationId)
      .eq("status", "active")
      .eq("can_post", true)
      .is("deleted_at", null)
      .order("username"),
    admin
      .from("twitter_media_assets")
      .select("id,original_name,media_kind,byte_size,storage_path,created_at")
      .eq("organization_id", organizationId)
      .eq("status", "ready")
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(31),
    admin
      .from("twitter_groups")
      .select("id,name")
      .eq("organization_id", organizationId)
      .is("deleted_at", null)
      .order("name"),
    admin
      .from("twitter_group_members")
      .select("group_id,profile_id")
      .eq("organization_id", organizationId),
    admin
      .from("twitter_media_group_members")
      .select("group_id,asset_id")
      .eq("organization_id", organizationId),
    admin.rpc("twitter_bulk_profile_queue_summary", {
      p_organization_id: organizationId,
    }),
  ]);
  if (
    profilesResult.error ||
    assetsResult.error ||
    groupsResult.error ||
    membershipsResult.error ||
    queueResult.error
  )
    throw new Error("Não foi possível abrir a postagem X.");
  const formatQueueResult = await admin.rpc(
    "twitter_bulk_profile_format_summary",
    { p_organization_id: organizationId },
  );
  const effectiveQueueData = formatQueueResult.error
    ? queueResult.data
    : formatQueueResult.data;
  const profiles = profilesResult.data ?? [];
  const connectionIds = [
    ...new Set(
      profiles
        .map((profile) => profile.current_connection_id)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const { data: connections, error: connectionError } = connectionIds.length
    ? await admin
        .from("twitter_connections")
        .select("id,identity_id")
        .eq("organization_id", organizationId)
        .in("id", connectionIds)
    : { data: [], error: null };
  if (connectionError)
    throw new Error("Não foi possível carregar as carteiras X.");
  const identityByConnection = new Map(
    (connections ?? []).map((connection) => [
      connection.id,
      connection.identity_id,
    ]),
  );
  const identityIds = [
    ...new Set((connections ?? []).map((connection) => connection.identity_id)),
  ];
  const { data: wallets, error: walletError } = identityIds.length
    ? await admin
        .from("twitter_wallets")
        .select("identity_id,posted_balance_micros,reserved_micros")
        .eq("organization_id", organizationId)
        .in("identity_id", identityIds)
    : { data: [], error: null };
  if (walletError) throw new Error("Não foi possível carregar os saldos X.");
  const walletByIdentity = new Map(
    (wallets ?? []).map((wallet) => [wallet.identity_id, wallet]),
  );
  const queueByProfile = new Map(
    (effectiveQueueData ?? []).map((row: { profile_id: string }) => [
      row.profile_id,
      row,
    ]),
  );
  const groupIdsByProfile = new Map<string, string[]>();
  for (const member of membershipsResult.data ?? [])
    groupIdsByProfile.set(member.profile_id, [
      ...(groupIdsByProfile.get(member.profile_id) ?? []),
      member.group_id,
    ]);
  const groupIdsByAsset = new Map<string, string[]>();
  for (const member of mediaMembershipsResult.error
    ? []
    : (mediaMembershipsResult.data ?? []))
    groupIdsByAsset.set(member.asset_id, [
      ...(groupIdsByAsset.get(member.asset_id) ?? []),
      member.group_id,
    ]);
  const assetRows=(assetsResult.data??[]).slice(0,30);
  const assets = await Promise.all(
    assetRows.map(async (asset) => {
      const { data: signed } = await admin.storage
        .from("twitter-media")
        .createSignedUrl(asset.storage_path, 900);
      return {
        id: asset.id,
        original_name: asset.original_name,
        media_kind: asset.media_kind,
        byte_size: Number(asset.byte_size),
        signed_url: signed?.signedUrl ?? null,
        group_ids: groupIdsByAsset.get(asset.id) ?? [],
      };
    }),
  );
  return (
    <main className="standalone-page">
      <TwitterBulkClient
        profileGroups={groupsResult.data ?? []}
        mediaGroups={groupsResult.data ?? []}
        assets={assets}
        initialMediaHasMore={(assetsResult.data?.length??0)>30}
        initialMediaCursor={(assetsResult.data?.length??0)>30&&assetRows.at(-1)?Buffer.from(JSON.stringify({createdAt:assetRows.at(-1)!.created_at,id:assetRows.at(-1)!.id})).toString('base64url'):null}
        profiles={profiles.map((profile) => {
          const identityId =
            identityByConnection.get(profile.current_connection_id ?? "") ?? "";
          const wallet = walletByIdentity.get(identityId);
          const queue = queueByProfile.get(profile.id) as
            Record<string, unknown> | undefined;
          const posted = Number(wallet?.posted_balance_micros ?? 0);
          const reserved = Number(wallet?.reserved_micros ?? 0);
          return {
            id: profile.id,
            username: profile.username,
            display_name: profile.display_name,
            avatar_url: profile.avatar_url,
            account_tier: profile.account_tier,
            identity_id: identityId,
            posted_micros: posted,
            reserved_micros: reserved,
            available_micros: posted - reserved,
            group_ids: groupIdsByProfile.get(profile.id) ?? [],
            queue: {
              text_count: Number(queue?.text_count ?? 0),
              image_count: Number(queue?.image_count ?? 0),
              gif_count: Number(queue?.gif_count ?? 0),
              video_count: Number(queue?.video_count ?? 0),
              published_text_count: Number(queue?.published_text_count ?? 0),
              published_image_count: Number(queue?.published_image_count ?? 0),
              published_gif_count: Number(queue?.published_gif_count ?? 0),
              published_video_count: Number(queue?.published_video_count ?? 0),
              pending_count: Number(queue?.pending_count ?? 0),
              blocking_count: Number(queue?.blocking_count ?? 0),
              last_execute_at:
                typeof queue?.last_execute_at === "string"
                  ? queue.last_execute_at
                  : null,
            },
          };
        })}
      />
    </main>
  );
}
