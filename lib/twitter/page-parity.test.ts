import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("revisão em massa entrega exatamente o contrato financeiro renderizado pela tela", async () => {
  const [route, client] = await Promise.all([
    readFile(
      new URL("../../app/api/x/bulk/review/route.ts", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../../app/x/twitter-bulk-client.tsx", import.meta.url),
      "utf8",
    ),
  ]);
  for (const field of [
    "costBreakdown",
    "walletSnapshots",
    "shortfalls",
    "reservedMicros",
  ]) {
    assert.match(route, new RegExp(`${field}: review\\.${field}`));
    assert.match(client, new RegExp(`review\\.${field}`));
  }
  assert.doesNotMatch(
    route,
    /wallets:review\.walletSnapshots|wallets:\s*review\.walletSnapshots/,
  );
  assert.match(client, /contrato incompleto/);
  assert.doesNotMatch(
    `${route}\n${client}`,
    /instagram_profiles|public\.publication_items/,
  );
});

test("remoção de mídia preserva objeto congelado e grupos X permitem edição", async () => {
  const [mediaRoute, gallery, groups] = await Promise.all([
    readFile(
      new URL("../../app/api/x/media/[assetId]/route.ts", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../../app/galeria/gallery-client.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../../app/x/twitter-groups-client.tsx", import.meta.url),
      "utf8",
    ),
  ]);
  assert.match(mediaRoute, /twitter_program_media_set_assets/);
  assert.match(mediaRoute, /storageRetained/);
  assert.ok(
    mediaRoute.indexOf('status: "deleted"') < mediaRoute.indexOf(".remove(["),
  );
  assert.match(gallery, /mediaBucket = isTwitter/);
  assert.match(gallery, /thumbnail_url/);
  assert.doesNotMatch(gallery, /<video[^>]+autoPlay/);
  assert.match(groups, /editingId\s*\?\s*["']PUT["']\s*:\s*["']POST["']/);
  assert.match(groups, /description/);
  assert.match(groups, /if\s*\(!response\.ok\)\s*throw new Error/);
  assert.doesNotMatch(
    `${mediaRoute}\n${gallery}\n${groups}`,
    /instagram_profiles/,
  );
});

test("galeria X usa o cliente otimizado e os mesmos grupos dos perfis X", async () => {
  const [page, client, complete, fingerprint, migration, profileGroupMigration, groupRpcFix, css] = await Promise.all([
    readFile(
      new URL("../../app/(painel)/x/galeria/page.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../../app/galeria/gallery-client.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../../app/api/x/media/complete/route.ts", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../../lib/gallery/file-fingerprint.ts", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL(
        "../../supabase/migrations/249_twitter_gallery_parity.sql",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(
      new URL(
        "../../supabase/migrations/250_twitter_gallery_profile_groups.sql",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(
      new URL(
        "../../supabase/migrations/252_twitter_gallery_group_rpc_conflict.sql",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(new URL("../../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(page, /GalleryClient/);
  assert.match(page, /platform="twitter"/);
  for (const behavior of [
    "MAX_CONCURRENT_UPLOADS",
    "MAX_UPLOAD_ATTEMPTS",
    "fingerprintMediaFile",
    "createVideoFallbackThumbnail",
    "createGifThumbnail",
    "createRealVideoThumbnail",
    "recoverMissingThumbnails",
    "selectAllMatchingFilter",
  ])
    assert.match(client, new RegExp(behavior.replace(".", "\\.")));
  assert.match(complete, /sha256|checksum/);
  assert.match(complete, /duplicated/);
  assert.match(fingerprint, /crypto\.subtle\.digest/);
  assert.match(fingerprint, /chunkSize/);
  assert.match(migration, /twitter_media_assets_org_sha256_idx/);
  assert.match(migration, /twitter_gallery_media_page/);
  assert.match(page, /\.from\("twitter_groups"\)/);
  assert.doesNotMatch(page, /\.from\("twitter_media_groups"\)/);
  assert.doesNotMatch(client, /Criar grupo de mídia X|Gerar miniatura/);
  assert.match(client, /Grupo de perfis/);
  assert.match(client, /GALLERY_MIME_BY_EXTENSION/);
  assert.match(client, /jfif: "image\/jpeg"/);
  assert.match(client, /rejectedItems[\s\S]*permanecem visíveis na fila com o motivo/);
  assert.match(profileGroupMigration, /references public\.twitter_groups\(id\)/);
  assert.match(profileGroupMigration, /left join public\.twitter_groups profile_group/);
  assert.match(groupRpcFix, /requested\(asset_id\)/);
  assert.match(groupRpcFix, /requested\(group_id\)/);
  assert.match(groupRpcFix, /on conflict on constraint twitter_media_group_members_pkey/);
  assert.doesNotMatch(groupRpcFix, /unnest\(p_(media_asset|group)_ids\) id/);
  assert.match(css, /label:not\(\.media-select\):has/);
  assert.doesNotMatch(
    `${page}\n${complete}\n${migration}\n${profileGroupMigration}`,
    /instagram_profiles|instagram_media_assets|instagram-media/,
  );
});

test("composer X preserva a estrutura compacta e as interações críticas do Instagram", async () => {
  const [client, page, migration] = await Promise.all([
    readFile(
      new URL("../../app/x/twitter-bulk-client.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../../app/(painel)/x/postagem/page.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL(
        "../../supabase/migrations/248_twitter_media_groups.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  ]);
  assert.match(client, /bulk-publishing\.module\.css/);
  assert.match(client, /toggleBulkProfileSelection/);
  assert.match(client, /event\.shiftKey/);
  assert.match(client, /Adicionar texto/);
  assert.match(client, /contentReady/);
  assert.match(client, /Opcional — deixe vazio para publicar somente a mídia/);
  assert.match(client, /fillTwitterTextFieldsFromClipboard/);
  assert.match(client, /Origem de mídia/);
  assert.match(client, /Todos os[\s\S]*elegíveis da origem serão usados/);
  assert.match(client, /format === "images"/);
  assert.match(client, /resolveTwitterImageRotationSets\(originAssets, imageSets\)/);
  assert.match(client, /Ordem da rotação/);
  assert.match(client, /Diversificada e determinística/);
  assert.match(client, /Mesma ordem em todos os perfis/);
  assert.match(client, /orderMode,/);
  assert.match(client, /rotationSeed: rotationSeedValue/);
  assert.match(client, /todas as imagens compatíveis serão publicadas uma a uma/i);
  assert.match(client, /somente eles serão publicados e cada conjunto formará um post/i);
  assert.match(page, /twitter_bulk_profile_format_summary/);
  assert.match(migration, /published_(text|image|gif|video)_count/);
  assert.doesNotMatch(
    `${client}\n${page}\n${migration}`,
    /instagram_profiles|instagram_media_assets/,
  );
});
