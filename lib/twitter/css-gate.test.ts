import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('layout X fornece um escopo visual exclusivo para todas as páginas do módulo', async () => {
  const [layout, css] = await Promise.all([
    readFile(new URL('../../app/(painel)/x/layout.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../app/globals.css', import.meta.url), 'utf8'),
  ]);
  assert.match(layout, /className="twitter-module-shell"/);
  for (const primitive of ['page-stack', 'content-stack', 'summary-grid', 'notice-banner', 'actions-row', 'action-row', 'button-row', 'muted']) {
    assert.match(css, new RegExp(`\\.twitter-module-shell \\.${primitive}`));
  }
  assert.match(css, /\.twitter-module-shell \.standalone-header/);
  assert.match(css, /\.twitter-module-shell \.media-grid/);
  assert.match(css, /repeat\(auto-fit, minmax\(min\(255px, 100%\), 1fr\)\)/);
  assert.match(css, /\.twitter-module-shell \.panel > label:has/);
  assert.match(css, /\.twitter-module-shell pre \{ max-width: 100%; overflow-x: auto/);
  assert.match(css, /overflow-wrap: anywhere/);
});

test('gate CSS cobre desktop, tablet, mobile estreito e controles acessíveis', async () => {
  const css = await readFile(new URL('../../app/globals.css', import.meta.url), 'utf8');
  assert.match(css, /@media \(max-width: 700px\)[\s\S]*\.twitter-module-shell/);
  assert.match(css, /@media \(max-width: 430px\)[\s\S]*\.twitter-module-shell/);
  assert.match(css, /\.twitter-module-shell \.page-heading, \.twitter-module-shell \.panel-heading/);
  assert.match(css, /\.twitter-module-shell \.page-heading h1 \{ overflow-wrap: anywhere/);
  assert.match(css, /focus-visible/);
  assert.match(css, /min-height: 44px/);
  assert.match(css, /max-height: calc\(100dvh - 16px\)/);
  assert.doesNotMatch(css, /twitter-module-shell[\s\S]{0,120}instagram_profiles/);
});
