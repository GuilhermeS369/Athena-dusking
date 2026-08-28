import fs from 'node:fs/promises';
import path from 'node:path';

const SAFE_ID = /^[0-9a-f-]{20,64}$/i;

function assertEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object') throw new TypeError('Envelope de publicação inválido.');
  if (!SAFE_ID.test(String(envelope.itemId ?? ''))) throw new TypeError('ID do envelope de publicação inválido.');
  if (!Number.isFinite(Date.parse(envelope.executeAt ?? ''))) throw new TypeError('Horário do envelope de publicação inválido.');
  if (!envelope.workItem || typeof envelope.workItem !== 'object') throw new TypeError('Snapshot do item ausente.');
}

function compareEnvelopes(left, right) {
  return Date.parse(left.executeAt) - Date.parse(right.executeAt)
    || String(left.organizationId ?? '').localeCompare(String(right.organizationId ?? ''))
    || String(left.profileId ?? '').localeCompare(String(right.profileId ?? ''))
    || String(left.itemId).localeCompare(String(right.itemId));
}

export class PublicationDispatchSpool {
  constructor(directory) {
    if (!directory || !path.isAbsolute(directory)) throw new TypeError('O diretório do spool deve ser absoluto.');
    this.directory = directory;
  }

  filePath(itemId) {
    if (!SAFE_ID.test(String(itemId ?? ''))) throw new TypeError('ID do spool inválido.');
    return path.join(this.directory, `${itemId}.json`);
  }

  async initialize() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await fs.chmod(this.directory, 0o700).catch(() => {});
    const entries = await fs.readdir(this.directory, { withFileTypes: true });
    await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.tmp'))
      .map((entry) => fs.unlink(path.join(this.directory, entry.name)).catch(() => {})));
    return this;
  }

  async put(envelope) {
    assertEnvelope(envelope);
    const target = this.filePath(envelope.itemId);
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    const payload = JSON.stringify({ version: 1, stagedAt: new Date().toISOString(), ...envelope });
    await fs.writeFile(temporary, payload, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await fs.chmod(temporary, 0o600).catch(() => {});
    await fs.rename(temporary, target);
    await fs.chmod(target, 0o600).catch(() => {});
    return target;
  }

  async get(itemId) {
    try {
      const value = JSON.parse(await fs.readFile(this.filePath(itemId), 'utf8'));
      assertEnvelope(value);
      return value;
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }

  async list() {
    const entries = await fs.readdir(this.directory, { withFileTypes: true });
    const envelopes = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      try {
        const envelope = JSON.parse(await fs.readFile(path.join(this.directory, entry.name), 'utf8'));
        assertEnvelope(envelope);
        envelopes.push(envelope);
      } catch (error) {
        error.message = `Spool corrompido em ${entry.name}: ${error.message}`;
        throw error;
      }
    }
    return envelopes.sort(compareEnvelopes);
  }

  async listDue(now = Date.now(), limit = 500) {
    const safeLimit = Math.min(Math.max(Number(limit) || 1, 1), 5000);
    return (await this.list()).filter((entry) => Date.parse(entry.executeAt) <= now).slice(0, safeLimit);
  }

  async remove(itemId) {
    await fs.unlink(this.filePath(itemId)).catch((error) => {
      if (error?.code !== 'ENOENT') throw error;
    });
  }
}
