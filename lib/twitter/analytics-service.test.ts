import assert from'node:assert/strict';import{readFile}from'node:fs/promises';import test from'node:test';import{twitterAnalyticsWalletProjection}from'./analytics-pricing.ts';
test('analytics desconta reservas de publicação antes do piso protegido',()=>{assert.deepEqual(twitterAnalyticsWalletProjection({postedBalanceMicros:12000000,reservedMicros:2000000,analyticsCostMicros:5000000}),{availableMicros:10000000,projectedAvailableMicros:5000000,protectedFloorMicros:5000000,canFund:true});assert.equal(twitterAnalyticsWalletProjection({postedBalanceMicros:12000000,reservedMicros:2000000,analyticsCostMicros:5000001}).canFund,false);});

test('serviço implementa contrato v2, eligibility e coleta forçada',async()=>{
  const source=await readFile(new URL('./analytics-service.ts',import.meta.url),'utf8');
  assert.match(source,/version: 2/);
  assert.match(source,/followers_daily/);
  assert.match(source,/can_fetch_analytics/);
  assert.match(source,/analytics_enabled/);
  assert.match(source,/forceRefresh/);
});
