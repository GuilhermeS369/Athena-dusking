#!/usr/bin/env node

import fs from 'node:fs';
import process from 'node:process';

const reportPath = process.argv[2] ?? 'luiz-miguel-reels-recovery-after.json';
const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
const chunkStatusCounts = report.chunks.reduce((counts, chunk) => {
  counts[chunk.status] = (counts[chunk.status] ?? 0) + 1;
  return counts;
}, {});
const planProfileStatusCounts = report.planProfiles.reduce((counts, planProfile) => {
  counts[planProfile.status] = (counts[planProfile.status] ?? 0) + 1;
  return counts;
}, {});

console.log(JSON.stringify({
  plan: report.plan,
  chunkStatusCounts,
  planProfileStatusCounts,
  horizonConflictChunkCount: report.horizonConflictChunks.length,
  recoverableChunkCount: report.recoverableChunks.length,
  unavailableConflictChunks: report.unavailableConflictChunks,
}, null, 2));
