import assert from "node:assert/strict";
import test from "node:test";
import {
  fillTwitterTextFieldsFromClipboard,
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
