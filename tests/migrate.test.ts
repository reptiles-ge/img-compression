import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveImageConfig } from '../src/config.js';
import { loadManifest } from '../src/manifest.js';
import { runMigration } from '../src/migrate.js';
import { manifestKey } from '../src/naming.js';
import { LocalStorageAdapter } from '../src/storage/local.js';
import { createTemporaryDirectory, gradientJpeg, gradientPng } from './fixtures.js';

const config = resolveImageConfig({}, {});

describe('runMigration', () => {
  let directory: Awaited<ReturnType<typeof createTemporaryDirectory>>;
  let storage: LocalStorageAdapter;

  beforeEach(async () => {
    directory = await createTemporaryDirectory();
    storage = new LocalStorageAdapter({ root: directory.path });

    await storage.put('original/species/viper.jpg', await gradientJpeg({ width: 2000, height: 1400 }), {
      contentType: 'image/jpeg',
    });
    await storage.put('original/species/gecko.png', await gradientPng({ width: 900, height: 600 }), {
      contentType: 'image/png',
    });
    await storage.put('original/notes.txt', Buffer.from('not an image', 'utf8'), {
      contentType: 'text/plain',
    });
  });

  afterEach(async () => {
    await directory.cleanup();
  });

  it('optimises every original without modifying any of them', async () => {
    const before = await Promise.all([
      storage.get('original/species/viper.jpg'),
      storage.get('original/species/gecko.png'),
    ]);

    const summary = await runMigration({ storage, config, concurrency: 2 });

    expect(summary).toMatchObject({ total: 2, processed: 2, failed: 0 });

    const after = await Promise.all([
      storage.get('original/species/viper.jpg'),
      storage.get('original/species/gecko.png'),
    ]);
    expect(after[0]?.equals(before[0]!)).toBe(true);
    expect(after[1]?.equals(before[1]!)).toBe(true);
  });

  it('ignores files that are not images', async () => {
    const summary = await runMigration({ storage, config });

    expect(summary.total).toBe(2);
    expect(await storage.exists('original/notes.txt')).toBe(true);
  });

  it('is idempotent: a second run re-encodes nothing and adds no duplicates', async () => {
    const first = await runMigration({ storage, config });
    const filesAfterFirst = await storage.list('');

    const second = await runMigration({ storage, config });
    const filesAfterSecond = await storage.list('');

    expect(first.processed).toBe(2);
    expect(second.processed).toBe(0);
    expect(second.skipped).toBe(2);
    expect(filesAfterSecond).toEqual(filesAfterFirst);
  });

  it('produces byte-identical derivatives when forced to redo the work', async () => {
    await runMigration({ storage, config });
    const before = await storage.get('optimized/species/viper-1200.avif');

    await runMigration({ storage, config, force: true });
    const after = await storage.get('optimized/species/viper-1200.avif');

    expect(after?.equals(before!)).toBe(true);
  });

  it('records every processed image in the manifest', async () => {
    await runMigration({ storage, config });

    const manifest = await loadManifest(storage, manifestKey(config));
    expect(Object.keys(manifest.entries).sort()).toEqual([
      'species/gecko.png',
      'species/viper.jpg',
    ]);

    const entry = manifest.entries['species/viper.jpg'];
    expect(entry?.originalKey).toBe('original/species/viper.jpg');
    expect(entry?.derivatives).toHaveLength(4);
  });

  it('writes nothing during a dry run', async () => {
    const before = await storage.list('');

    const summary = await runMigration({ storage, config, dryRun: true });

    expect(summary).toMatchObject({ dryRun: true, planned: 2, processed: 0 });
    expect(await storage.list('')).toEqual(before);
  });

  it('reports images already up to date during a dry run', async () => {
    await runMigration({ storage, config });

    const summary = await runMigration({ storage, config, dryRun: true });
    expect(summary).toMatchObject({ planned: 0, skipped: 2 });
  });

  it('restricts a run to a key prefix', async () => {
    const summary = await runMigration({ storage, config, keyPrefix: 'species/gecko' });

    expect(summary.total).toBe(1);
    expect(await storage.exists('optimized/species/gecko-900.avif')).toBe(true);
    expect(await storage.exists('optimized/species/viper-1200.avif')).toBe(false);
  });

  it('honours a limit', async () => {
    const summary = await runMigration({ storage, config, limit: 1 });
    expect(summary.total).toBe(1);
  });

  it('reports a failure without aborting the rest of the run', async () => {
    await storage.put('original/species/broken.jpg', Buffer.from('\xff\xd8\xff not really', 'binary'), {
      contentType: 'image/jpeg',
    });

    const summary = await runMigration({ storage, config });

    expect(summary.failed).toBe(1);
    expect(summary.processed).toBe(2);
    expect(summary.failures[0]?.key).toBe('species/broken.jpg');
    expect(summary.failures[0]?.code).not.toBeNull();
    expect(await storage.exists('original/species/broken.jpg')).toBe(true);
  });

  it('emits progress events for every image', async () => {
    const events: string[] = [];
    await runMigration({
      storage,
      config,
      onEvent: (event) => {
        if (event.type === 'item') events.push(`${event.status}:${event.key}`);
      },
    });

    expect(events.sort()).toEqual(['processed:species/gecko.png', 'processed:species/viper.jpg']);
  });
});
