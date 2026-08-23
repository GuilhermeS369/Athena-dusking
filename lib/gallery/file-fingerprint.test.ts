import assert from "node:assert/strict";
import test from "node:test";

import { fingerprintMediaFile } from "./file-fingerprint.ts";

test("fingerprint de arquivo comum mantém o SHA-256 integral", async () => {
  const bytes = new TextEncoder().encode("abc");
  const file = {
    size: bytes.byteLength,
    arrayBuffer: async () => bytes.slice().buffer,
    slice: (start?: number, end?: number) =>
      new Blob([bytes.slice(start, end)]),
  };
  assert.equal(
    await fingerprintMediaFile(file),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});
