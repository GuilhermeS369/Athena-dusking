import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  TWITTER_ANALYTICS_POST_READ_RESERVE_UNITS,
  twitterAnalyticsReservedAmountMicros,
} from "./analytics-pricing.ts";

test("post analytics reserves nine reads but keeps the unit price", () => {
  assert.equal(TWITTER_ANALYTICS_POST_READ_RESERVE_UNITS, 9);
  assert.deepEqual(twitterAnalyticsReservedAmountMicros("post", 5_000), {
    reservedUnits: 9,
    amountMicros: 45_000,
  });
  assert.deepEqual(twitterAnalyticsReservedAmountMicros("profile", 10_000), {
    reservedUnits: 1,
    amountMicros: 10_000,
  });
});

test("billing fan-out migration settles proven units and releases the remainder", async () => {
  const migration = await readFile(
    new URL(
      "../../supabase/migrations/246_twitter_analytics_billing_fanout.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(migration, /reserved_units', 9/);
  assert.match(migration, /settled := i\.unit_cost_micros \* p_billed_units/);
  assert.match(migration, /released := i\.amount_micros - settled/);
  assert.match(migration, /status in \('processing', 'outcome_unknown'\)/);
  assert.doesNotMatch(migration, /instagram_profiles|public\.publication_items/);
});
