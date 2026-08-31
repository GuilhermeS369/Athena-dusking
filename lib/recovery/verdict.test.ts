import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RECOVERY_VERDICT_THRESHOLDS,
  classifyRecoveryVerdict,
  formatZeroViewRate,
} from './verdict.ts';

const base = {
  postsSince: 90,
  originMedianVs: 100,
  originProfiles: 6,
  recoveryIndex: 0.5,
};

test('acima do corte aberto o perfil esta recuperado', () => {
  assert.equal(classifyRecoveryVerdict(base), 'recovered');
});

test('a fronteira de 0,40 pertence a "recuperado"', () => {
  // O corte aberto e o mesmo que o Filtro 1 usa para condenar. Se 0,40 exato
  // caisse em "parcial", entrada e saida deixariam de ser simetricas e um
  // perfil poderia sair da esteira e ser reacusado na mesma rodada.
  assert.equal(classifyRecoveryVerdict({ ...base, recoveryIndex: 0.4 }), 'recovered');
  assert.equal(
    classifyRecoveryVerdict({ ...base, recoveryIndex: 0.3999 }),
    'partial',
  );
});

test('a fronteira de 0,25 pertence a "parcial"', () => {
  assert.equal(classifyRecoveryVerdict({ ...base, recoveryIndex: 0.25 }), 'partial');
  assert.equal(
    classifyRecoveryVerdict({ ...base, recoveryIndex: 0.2499 }),
    'not_recovered',
  );
});

test('sem post medido o veredito e "sem dados", nunca "nao recuperou"', () => {
  // Um perfil que ainda nao postou nao e um perfil que falhou.
  assert.equal(classifyRecoveryVerdict({ ...base, postsSince: 0 }), 'no_data');
  assert.equal(classifyRecoveryVerdict({ ...base, postsSince: null }), 'no_data');
});

test('origem sem referencia nao autoriza veredito', () => {
  assert.equal(
    classifyRecoveryVerdict({ ...base, originMedianVs: 0 }),
    'no_reference',
  );
  assert.equal(
    classifyRecoveryVerdict({ ...base, originMedianVs: null }),
    'no_reference',
  );
  assert.equal(
    classifyRecoveryVerdict({ ...base, originProfiles: 4 }),
    'no_reference',
  );
});

test('volume insuficiente espera em vez de mentir', () => {
  assert.equal(
    classifyRecoveryVerdict({ ...base, postsSince: RECOVERY_VERDICT_THRESHOLDS.minPosts - 1 }),
    'short_sample',
  );
  assert.equal(
    classifyRecoveryVerdict({ ...base, postsSince: RECOVERY_VERDICT_THRESHOLDS.minPosts }),
    'recovered',
  );
});

test('"nao sei" vem antes de "ruim" na ordem das checagens', () => {
  // Indice pessimo, mas sem referencia: o veredito tem de ser a ausencia de
  // referencia, nao a condenacao.
  assert.equal(
    classifyRecoveryVerdict({
      postsSince: 200,
      originMedianVs: null,
      originProfiles: 0,
      recoveryIndex: 0.01,
    }),
    'no_reference',
  );
});

test('indice nao finito nao vira condenacao', () => {
  assert.equal(
    classifyRecoveryVerdict({ ...base, recoveryIndex: Number.NaN }),
    'no_reference',
  );
  assert.equal(
    classifyRecoveryVerdict({ ...base, recoveryIndex: null }),
    'no_reference',
  );
});

test('a taxa de zerados sempre carrega o denominador', () => {
  // Sem o denominador, 40% sobre 5 posts lidos parece o mesmo que sobre 60.
  assert.equal(formatZeroViewRate(2, 5), '40% (5 posts)');
  assert.equal(formatZeroViewRate(24, 60), '40% (60 posts)');
  assert.equal(formatZeroViewRate(0, 1), '0% (1 post)');
  assert.equal(formatZeroViewRate(0, 0), 'sem posts medidos');
  assert.equal(formatZeroViewRate(null, null), 'sem posts medidos');
});
