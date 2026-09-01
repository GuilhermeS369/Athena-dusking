import assert from 'node:assert/strict';
import test from 'node:test';

import { isPublicationInfrastructureError as noApp } from './infrastructure-error.ts';
// A implementação do worker da VPS. O import cruzado é o ponto do arquivo:
// enquanto existirem dois despachantes, os dois têm de responder igual.
// @ts-expect-error o worker é .mjs sem tipos de propósito: ele roda com node puro
// na VPS e não tem nenhuma dependência de TypeScript. Importá-lo aqui é o que
// permite comparar as duas implementações.
import { isPublicationInfrastructureError as noWorker } from '../../scripts/workers/publication-direct-dispatch.mjs';

// A forma EXATA capturada no log de produção durante o incidente de 31/08/2026.
// O supabase-js não propaga o TypeError original de uma queda de rede: entrega
// este objeto simples, que não é instância de Error.
const QUEDA_DE_CONEXAO_COM_O_BANCO = {
  message: 'TypeError: fetch failed',
  details: [
    'TypeError: fetch failed',
    '',
    'Caused by: ConnectTimeoutError: Connect Timeout Error (attempted addresses: 104.18.38.10:443, 172.64.149.246:443, timeout: 10000ms) (UND_ERR_CONNECT_TIMEOUT)',
  ].join('\n'),
  hint: '',
  code: '',
};

const CASOS: Array<{ nome: string; erro: unknown; infraestrutura: boolean }> = [
  { nome: 'queda de conexão com o Supabase (o caso do incidente)', erro: QUEDA_DE_CONEXAO_COM_O_BANCO, infraestrutura: true },
  { nome: 'statement timeout do Postgres', erro: { code: '57014', message: 'canceling statement due to statement timeout' }, infraestrutura: true },
  { nome: 'falha de serialização', erro: { code: '40001', message: 'serialization failure' }, infraestrutura: true },
  { nome: 'deadlock', erro: { code: '40P01', message: 'deadlock detected' }, infraestrutura: true },
  { nome: 'TypeError de programação', erro: new TypeError("Cannot read properties of undefined (reading 'provider')"), infraestrutura: true },
  { nome: 'socket derrubado no meio', erro: { message: 'fetch failed', details: 'SocketError: other side closed', hint: '', code: '' }, infraestrutura: true },
  { nome: 'conexão resetada', erro: { message: 'request failed', details: 'Error: read ECONNRESET', hint: '', code: '' }, infraestrutura: true },
  { nome: 'DNS temporariamente indisponível', erro: { message: 'fetch failed', details: 'Error: getaddrinfo EAI_AGAIN db.supabase.co', hint: '', code: '' }, infraestrutura: true },

  { nome: 'mídia recusada pela plataforma', erro: { code: 'platform_error', message: 'Instagram não baixou a mídia' }, infraestrutura: false },
  { nome: 'token expirado', erro: { code: '190', message: 'Token expirado' }, infraestrutura: false },
  { nome: 'conteúdo recusado', erro: { code: 'user_content', message: 'Legenda recusada pela plataforma' }, infraestrutura: false },
  {
    nome: 'desfecho desconhecido da Zernio (terminal de propósito, para não duplicar post)',
    erro: { code: 'zernio_creation_outcome_unknown', message: 'A criação Zernio não retornou confirmação.' },
    infraestrutura: false,
  },
  { nome: 'nulo', erro: null, infraestrutura: false },
];

test('o app classifica infraestrutura como o esperado', () => {
  for (const caso of CASOS) {
    assert.equal(noApp(caso.erro), caso.infraestrutura, caso.nome);
  }
});

test('o worker da VPS e o cron da Vercel respondem igual, caso a caso', () => {
  for (const caso of CASOS) {
    assert.equal(
      noApp(caso.erro),
      noWorker(caso.erro),
      `os dois despachantes divergiram em: ${caso.nome}. Corrigir os DOIS — foi a divergência que custou 3.315 publicações em 31/08/2026.`,
    );
  }
});

test('a premissa do incidente: o erro do supabase-js não é um TypeError', () => {
  assert.equal(QUEDA_DE_CONEXAO_COM_O_BANCO instanceof TypeError, false);
  assert.equal(QUEDA_DE_CONEXAO_COM_O_BANCO instanceof Error, false);
});
