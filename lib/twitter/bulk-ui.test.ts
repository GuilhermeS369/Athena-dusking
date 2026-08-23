import assert from "node:assert/strict";
import test from "node:test";
import {
  fillTwitterTextFieldsFromClipboard,
  resolveTwitterImageRotationSets,
  twitterFormatProgress,
} from "./bulk-ui.ts";
test("colagem tabular preenche somente os campos de texto já abertos", () => {
  assert.deepEqual(
    fillTwitterTextFieldsFromClipboard(
      ["", "", ""],
      0,
      "um\ndois\ntres\nquatro",
    ),
    ["um", "dois", "tres"],
  );
  assert.deepEqual(
    fillTwitterTextFieldsFromClipboard(
      ["fixo", "", ""],
      1,
      "dois\ttres\tignorado",
    ),
    ["fixo", "dois", "tres"],
  );
});
test("colagem de um único texto preserva o comportamento nativo", () => {
  assert.equal(fillTwitterTextFieldsFromClipboard([""], 0, "um texto"), null);
});
test("barra por formato representa publicadas sobre publicadas mais agendadas", () => {
  assert.deepEqual(twitterFormatProgress(3, 7), {
    published: 3,
    scheduled: 7,
    total: 10,
    progress: 30,
  });
  assert.deepEqual(twitterFormatProgress(0, 0), {
    published: 0,
    scheduled: 0,
    total: 0,
    progress: 0,
  });
});

test("imagens da origem viram conjuntos individuais quando não há conjuntos manuais", () => {
  assert.deepEqual(resolveTwitterImageRotationSets([{id:"a"},{id:"b"}],[]),[
    {clientKey:"origin:images:a",mediaKind:"images",assetIds:["a"]},
    {clientKey:"origin:images:b",mediaKind:"images",assetIds:["b"]},
  ]);
});

test("conjuntos manuais substituem as imagens individuais da origem", () => {
  const manual=[{clientKey:"images:a:b",mediaKind:"images" as const,assetIds:["a","b"]}];
  assert.equal(resolveTwitterImageRotationSets([{id:"a"},{id:"b"},{id:"c"}],manual),manual);
});
