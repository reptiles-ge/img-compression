import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveImageConfig } from '../src/config.js';
import {
  emptyManifest,
  hashSource,
  isEntryFresh,
  loadManifest,
  saveManifest,
  type ManifestEntry,
} from '../src/manifest.js';
import { manifestKey } from '../src/naming.js';
import { LocalStorageAdapter } from '../src/storage/local.js';
import { createTemporaryDirectory } from './fixtures.js';

const config = resolveImageConfig({}, {});
const location = manifestKey(config);

function entry(overrides: Partial<ManifestEntry> = {}): ManifestEntry {
  return {
    sourceHash: 'a'.repeat(64),
    configFingerprint: 'fingerprint',
    originalKey: 'original/viper.jpg',
    originalSize: 1024,
    width: 2400,
    height: 1600,
    derivatives: [
      {
        key: 'optimized/viper-2400.avif',
        format: 'avif',
        width: 2400,
        height: 1600,
        byteSize: 100,
      },
    ],
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('manifest', () => {
  let directory: Awaited<ReturnType<typeof createTemporaryDirectory>>;
  let storage: LocalStorageAdapter;

  beforeEach(async () => {
    directory = await createTemporaryDirectory();
    storage = new LocalStorageAdapter({ root: directory.path });
  });

  afterEach(async () => {
    await directory.cleanup();
  });

  it('treats an absent manifest as empty', async () => {
    expect(await loadManifest(storage, location)).toEqual(emptyManifest());
  });

  it('round-trips entries', async () => {
    await saveManifest(storage, location, {
      ...emptyManifest(),
      entries: { 'viper.jpg': entry() },
    });

    const loaded = await loadManifest(storage, location);
    expect(loaded.entries['viper.jpg']).toEqual(entry());
  });

  it('writes byte-identical output regardless of key order', async () => {
    const a = entry();
    const b = entry({ originalKey: 'original/gecko.png' });

    await saveManifest(storage, location, {
      ...emptyManifest(),
      entries: { 'viper.jpg': a, 'gecko.png': b },
    });
    const first = await storage.get(location);

    await saveManifest(storage, location, {
      ...emptyManifest(),
      entries: { 'gecko.png': b, 'viper.jpg': a },
    });
    const second = await storage.get(location);

    expect(first?.equals(second!)).toBe(true);
  });

  it('rebuilds rather than throwing when the manifest is corrupt', async () => {
    const warnings: string[] = [];
    await storage.put(location, Buffer.from('{ not json', 'utf8'), {
      contentType: 'application/json',
    });

    const loaded = await loadManifest(storage, location, (message) => warnings.push(message));

    expect(loaded).toEqual(emptyManifest());
    expect(warnings).toHaveLength(1);
  });

  it('rebuilds when the manifest version is unrecognised', async () => {
    await storage.put(location, Buffer.from(JSON.stringify({ version: 99, entries: {} })), {
      contentType: 'application/json',
    });

    expect(await loadManifest(storage, location)).toEqual(emptyManifest());
  });

  it('discards entries that are not shaped like entries', async () => {
    await storage.put(
      location,
      Buffer.from(
        JSON.stringify({ version: 1, entries: { 'viper.jpg': entry(), 'junk.jpg': 42 } }),
      ),
      { contentType: 'application/json' },
    );

    const loaded = await loadManifest(storage, location);
    expect(Object.keys(loaded.entries)).toEqual(['viper.jpg']);
  });

  it('does not let a __proto__ key reach the prototype chain', async () => {
    await storage.put(
      location,
      Buffer.from(JSON.stringify({ version: 1, entries: { __proto__: entry() } })),
      { contentType: 'application/json' },
    );

    const loaded = await loadManifest(storage, location);

    expect(Object.getPrototypeOf(loaded.entries)).toBeNull();
    expect(({} as Record<string, unknown>)['sourceHash']).toBeUndefined();
  });
});

describe('isEntryFresh', () => {
  let directory: Awaited<ReturnType<typeof createTemporaryDirectory>>;
  let storage: LocalStorageAdapter;

  beforeEach(async () => {
    directory = await createTemporaryDirectory();
    storage = new LocalStorageAdapter({ root: directory.path });

    for (const key of ['original/viper.jpg', 'optimized/viper-2400.avif']) {
      await storage.put(key, Buffer.from('x'), { contentType: 'application/octet-stream' });
    }
  });

  afterEach(async () => {
    await directory.cleanup();
  });

  const hash = 'a'.repeat(64);

  it('is fresh when the hash, the settings and every file agree', async () => {
    expect(await isEntryFresh(entry(), hash, 'fingerprint', storage)).toBe(true);
  });

  it('is stale when the source changed', async () => {
    expect(
      await isEntryFresh(entry(), hashSource(Buffer.from('different')), 'fingerprint', storage),
    ).toBe(false);
  });

  it('is stale when the settings changed', async () => {
    expect(await isEntryFresh(entry(), hash, 'other-fingerprint', storage)).toBe(false);
  });

  it('is stale when the original is missing', async () => {
    expect(
      await isEntryFresh(entry({ originalKey: 'original/gone.jpg' }), hash, 'fingerprint', storage),
    ).toBe(false);
  });

  it('is stale when a derivative is missing', async () => {
    const missing = entry({
      derivatives: [
        { key: 'optimized/gone-2400.avif', format: 'avif', width: 2400, height: 1600, byteSize: 1 },
      ],
    });

    expect(await isEntryFresh(missing, hash, 'fingerprint', storage)).toBe(false);
  });

  it('is stale when there is no entry at all', async () => {
    expect(await isEntryFresh(undefined, hash, 'fingerprint', storage)).toBe(false);
  });
});
