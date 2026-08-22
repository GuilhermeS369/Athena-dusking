import assert from 'node:assert/strict';
import test from 'node:test';

import { isTwitterAnalyticsEnabled, isTwitterModuleEnabled } from './feature.ts';

test('módulo fica desligado por padrão e aceita canário explícito', () => {
  assert.equal(isTwitterModuleEnabled('org-a', {}), false);
  assert.equal(isTwitterModuleEnabled('org-a', {
    TWITTER_MODULE_ENABLED: 'false',
    TWITTER_CANARY_ORGANIZATION_IDS: 'org-b,org-a',
  }), true);
});

test('analytics exige flag e organização canário ao mesmo tempo', () => {
  assert.equal(isTwitterAnalyticsEnabled('org-a', {
    TWITTER_ANALYTICS_ENABLED: 'true',
    TWITTER_CANARY_ORGANIZATION_IDS: 'org-a',
  }), true);
  assert.equal(isTwitterAnalyticsEnabled('org-b', {
    TWITTER_ANALYTICS_ENABLED: 'true',
    TWITTER_CANARY_ORGANIZATION_IDS: 'org-a',
  }), false);
});
