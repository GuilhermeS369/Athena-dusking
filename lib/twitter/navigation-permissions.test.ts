import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('menu separa Instagram e X e mantém páginas gerais fora dos módulos', async () => {
  const shell = await readFile(new URL('../../app/components/app-shell.tsx', import.meta.url), 'utf8');
  for (const href of ['/postagem', '/queue', '/galeria', '/perfis', '/grupos', '/agenda', '/zernio', '/operacao']) assert.match(shell, new RegExp(`href: '${href}'`));
  for (const href of ['/x/analises', '/x/postagem', '/x/fila', '/x/galeria', '/x/perfis', '/x/grupos', '/x/agenda', '/x/zernio', '/x/logs']) assert.match(shell, new RegExp(`href: '${href}'`));
  assert.match(shell, /renderSection\('instagram', 'Instagram'/);
  assert.match(shell, /renderSection\('twitter', 'X\/Twitter'/);
  assert.match(shell, /label: 'Dashboard'.*href: '\/'/);
  assert.match(shell, /label: 'Importação em massa'.*href: '\/bulk-import'/);
});

test('Viewer não recebe composer de postagem e APIs mutáveis exigem Operator ou Admin', async () => {
  const [page, review, confirm] = await Promise.all([
    readFile(new URL('../../app/(painel)/x/postagem/page.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../app/api/x/bulk/review/route.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../app/api/x/bulk/confirm/route.ts', import.meta.url), 'utf8'),
  ]);
  assert.match(page, /role==='viewer'/);
  assert.match(page, /Somente leitura/);
  assert.match(review, /getTwitterRequestContext\('operator'\)/);
  assert.match(confirm, /getTwitterRequestContext\('operator'\)/);
});
