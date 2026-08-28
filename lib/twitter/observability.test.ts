import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeTwitterLogCursor,
  encodeTwitterLogCursor,
  normalizeTwitterErrorMessage,
  sanitizeTwitterEvidence,
  twitterObservabilityFingerprint,
  twitterSeverityForResult,
} from "./observability.ts";

test("assinatura agrupa o mesmo erro entre perfis e separa etapas", () => {
  const base = { domain: "publication" as const, stage: "publication", stableCode: "account_unavailable", httpStatus: 401 };
  assert.equal(twitterObservabilityFingerprint(base), twitterObservabilityFingerprint({ ...base, httpStatus: 403 }));
  assert.notEqual(twitterObservabilityFingerprint(base), twitterObservabilityFingerprint({ ...base, stage: "sync" }));
});

test("mensagens e evidências removem identificadores e segredos", () => {
  const message = normalizeTwitterErrorMessage("Falha 123456 em https://example.test/a para 550e8400-e29b-41d4-a716-446655440000");
  assert.equal(message, "Falha <n> em <url> para <id>");
  assert.deepEqual(sanitizeTwitterEvidence({ token: "secret", nested: { apiKey: "secret", code: "safe" }, count: 2 }), { nested: { code: "safe" }, count: 2 });
});

test("cursor é opaco e inválidos são recusados", () => {
  const cursor = { at: "2026-08-24T10:00:00.000Z", id: "550e8400-e29b-41d4-a716-446655440000" };
  assert.deepEqual(decodeTwitterLogCursor(encodeTwitterLogCursor(cursor)), cursor);
  assert.equal(decodeTwitterLogCursor("invalid"), null);
});

test("resultado incerto é crítico e rate limit é aviso", () => {
  assert.equal(twitterSeverityForResult("outcome_unknown"), "critical");
  assert.equal(twitterSeverityForResult("retry", 429), "warning");
  assert.equal(twitterSeverityForResult("published", 200), "info");
});
