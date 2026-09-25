import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MORELOGIN_CHROME_DESCRIPTIONS,
  MORELOGIN_CHROME_HEADERS,
  buildMoreLoginChromePackage,
  buildMoreLoginChromeRows,
  buildMoreLoginChromeSheetXml,
} from './chrome-workbook.ts';

const profile = { profileName: 'conta1', login: 'conta1', password: 'Senha01', twoFa: 'ABCDEFGHIJKLMNOP', proxy: '1.2.3.4:5000:user:pass' };

test('linha de dados segue o modelo aceito: twitter + x.com, sem observação', () => {
  const rows = buildMoreLoginChromeRows([profile], 'HTTP', '  Grupo X  ');
  assert.equal(rows.length, 4);
  assert.equal(MORELOGIN_CHROME_HEADERS.length, 16);
  assert.equal(MORELOGIN_CHROME_DESCRIPTIONS.length, 16);
  assert.deepEqual(rows[3], ['conta1', 'twitter', 'https://x.com', 'conta1', 'Senha01', 'ABCDEFGHIJKLMNOP', '', 'HTTP', '1.2.3.4:5000:user:pass', '', '', 'Grupo X', '', '', '', '']);
});

test('perfil sem proxy não leva tipo de proxy', () => {
  const [, , , row] = buildMoreLoginChromeRows([{ ...profile, proxy: undefined }], 'SOCKS5');
  assert.equal(row[7], '');
  assert.equal(row[8], '');
});

test('sheet usa inlineStr, omite células vazias e escapa XML', () => {
  const xml = buildMoreLoginChromeSheetXml([['a&b', '', `"<x>'`]]);
  assert.equal(
    xml,
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t xml:space="preserve">a&amp;b</t></is></c><c r="C1" t="inlineStr"><is><t xml:space="preserve">&quot;&lt;x&gt;&apos;</t></is></c></row></sheetData></worksheet>',
  );
});

test('pacote tem só as cinco partes do modelo e uma aba Sheet1', () => {
  const parts = buildMoreLoginChromePackage(buildMoreLoginChromeRows([profile], 'HTTP'));
  assert.deepEqual(Object.keys(parts).sort(), ['[Content_Types].xml', '_rels/.rels', 'xl/_rels/workbook.xml.rels', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml']);
  assert.match(parts['xl/workbook.xml'], /<sheet name="Sheet1" sheetId="1" r:id="rId1"\/>/);
  assert.match(parts['xl/worksheets/sheet1.xml'], /<c r="P2" t="inlineStr"><is><t xml:space="preserve">UA<\/t><\/is><\/c><\/row><row r="3">/);
});
