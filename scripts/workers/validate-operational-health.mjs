#!/usr/bin/env node

import fs from 'node:fs';
import process from 'node:process';

loadEnvFile('.env.local');
loadEnvFile('.env.worker');

const baseUrl = (process.argv[2] || process.env.PUBLICATION_WORKER_APP_BASE_URL || 'https://pomodoro-theta-one-82.vercel.app').replace(/\/$/, '');
const secret = process.env.PUBLICATION_WORKER_SECRET || process.env.MEDIA_DELETION_WORKER_SECRET || process.env.CRON_SECRET;

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex <= 0) continue;
    const key = trimmed.slice(0, separatorIndex).trim();
    if (process.env[key]) continue;
    let value = trimmed.slice(separatorIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

if (!secret) {
  console.error('PUBLICATION_WORKER_SECRET, MEDIA_DELETION_WORKER_SECRET ou CRON_SECRET não encontrado.');
  process.exit(1);
}

const response = await fetch(`${baseUrl}/api/internal/operational-health`, {
  headers: { 'x-publication-worker-secret': secret },
});
const text = await response.text();
let payload = null;
try {
  payload = JSON.parse(text);
} catch {
  // Mantém payload como null para mostrar um preview seguro abaixo.
}

console.log(JSON.stringify({
  httpStatus: response.status,
  ok: response.ok,
  operationalStatus: payload?.status ?? null,
  checkedAt: payload?.checkedAt ?? null,
  signals: payload?.signals ?? null,
  workers: payload?.workers ?? null,
  queue: payload?.queue ?? null,
  preview: payload ? undefined : text.slice(0, 300),
}, null, 2));

if (!response.ok && response.status !== 503) process.exit(1);
