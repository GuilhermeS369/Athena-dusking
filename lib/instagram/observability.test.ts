import assert from "node:assert/strict";
import test from "node:test";

import { decodeInstagramCursor, encodeInstagramCursor, instagramDomainsForScope, instagramIncidentActions, instagramPeriodDays, safeInstagramSearch, sanitizeInstagramEvidence } from "./observability.ts";

test("cursor Instagram round-trips and rejects malformed input", () => {
  const cursor = { at: "2026-08-26T12:00:00.000Z", id: "123e4567-e89b-42d3-a456-426614174000" };
  assert.deepEqual(decodeInstagramCursor(encodeInstagramCursor(cursor)), cursor);
  assert.equal(decodeInstagramCursor("invalid"), null);
});

test("period is capped at the 14 day hot retention", () => {
  assert.equal(instagramPeriodDays("24h"), 1);
  assert.equal(instagramPeriodDays("7d"), 7);
  assert.equal(instagramPeriodDays("90d"), 14);
});

test("scope and search helpers keep queries bounded", () => {
  assert.deepEqual(instagramDomainsForScope("analytics_media"), ["analytics", "media"]);
  assert.deepEqual(instagramDomainsForScope("analytics"), ["analytics"]);
  assert.deepEqual(instagramDomainsForScope("media"), ["media"]);
  assert.equal(safeInstagramSearch(" @perfil; drop table! "), "@perfil drop table");
});

test("incident actions are server-authorized by role and state", () => {
  assert.deepEqual(instagramIncidentActions("viewer", "action_required"), []);
  assert.deepEqual(instagramIncidentActions("operator", "action_required"), ["investigate", "resolve"]);
  assert.deepEqual(instagramIncidentActions("admin", "investigating"), ["resolve"]);
  assert.deepEqual(instagramIncidentActions("operator", "resolved"), ["investigate"]);
});

test("viewer evidence sanitizer removes credentials and long URLs", () => {
  assert.deepEqual(sanitizeInstagramEvidence({ token: "secret", safe: 2, nested: { authorization: "x", result: "https://example.test/private" } }), { safe: 2, nested: { result: "[url removida]" } });
});
