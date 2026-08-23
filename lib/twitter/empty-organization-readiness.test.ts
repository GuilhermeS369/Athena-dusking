import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("organização nova recebe onboarding X sem chamada externa acidental", async () => {
  const [
    bulk,
    zernio,
    profilesPage,
    profilesClient,
    queue,
    agenda,
    analytics,
    gallery,
    groups,
  ] = await Promise.all([
    readFile(
      new URL("../../app/x/twitter-bulk-client.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../../app/x/twitter-zernio-client.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../../app/(painel)/x/perfis/page.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../../app/x/twitter-profiles-client.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../../app/x/twitter-queue-client.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../../app/x/twitter-agenda-client.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../../app/x/twitter-analytics-client.tsx", import.meta.url),
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
  assert.match(bulk, /Nenhum perfil X conectado/);
  assert.match(bulk, /href="\/x\/zernio"/);
  assert.match(bulk, /if\s*\(!profiles\.length\)\s*return/);
  assert.match(zernio, /Nenhuma conexão X/);
  assert.match(
    `${profilesPage}\n${profilesClient}`,
    /Nenhum perfil X conectado/,
  );
  assert.match(queue, /Fila X vazia/);
  assert.match(agenda, /Nenhuma publicação no filtro/);
  assert.match(analytics, /Nenhum post publicado corresponde aos filtros/);
  assert.match(gallery, /Nenhuma mídia na galeria/);
  assert.match(gallery, /platform === ["']twitter["']/);
  assert.match(groups, /Nenhum grupo criado/);
  assert.doesNotMatch(
    `${bulk}\n${queue}\n${agenda}\n${analytics}\n${gallery}\n${groups}`,
    /instagram_profiles|\/api\/v1\/analytics|zernio\.com/,
  );
});
