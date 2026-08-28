import { availableParallelism } from 'node:os';

import { resolveImageConfig, type ImageConfig } from './config.js';
import { ImagePipelineError } from './errors.js';
import { emptyManifest, loadManifest, saveManifest, type ManifestEntry } from './manifest.js';
import { manifestKey, parseKey } from './naming.js';
import { optimizeAndStore, planOptimization } from './pipeline.js';
import type { StorageAdapter } from './storage/types.js';

/** File extensions treated as candidate originals during a migration. */
const IMAGE_EXTENSIONS = new Set([
  'jpg',
  'jpeg',
  'png',
  'webp',
  'avif',
  'tif',
  'tiff',
  'heic',
  'heif',
]);

/** Manifest is checkpointed this often so a crash costs limited rework. */
const CHECKPOINT_INTERVAL = 25;

export type MigrationEvent =
  | { readonly type: 'discovered'; readonly total: number }
  | {
      readonly type: 'item';
      readonly key: string;
      readonly index: number;
      readonly total: number;
      readonly status: 'processed' | 'skipped' | 'planned' | 'up-to-date' | 'processing-disabled';
      readonly originalSize: number;
      readonly optimizedSize: number | null;
    }
  | { readonly type: 'failure'; readonly key: string; readonly message: string }
  | { readonly type: 'warning'; readonly message: string };

export interface MigrationFailure {
  readonly key: string;
  readonly message: string;
  readonly code: string | null;
}

export interface MigrationSummary {
  readonly total: number;
  readonly processed: number;
  readonly skipped: number;
  readonly planned: number;
  readonly failed: number;
  readonly originalBytes: number;
  /** Sum of the largest AVIF per processed image: what a modern browser fetches. */
  readonly optimizedBytes: number;
  readonly storedBytes: number;
  readonly failures: readonly MigrationFailure[];
  readonly dryRun: boolean;
}

export interface MigrationOptions {
  readonly storage: StorageAdapter;
  readonly config?: ImageConfig;
  /** Restrict the run to keys beginning with this logical prefix. */
  readonly keyPrefix?: string;
  readonly force?: boolean;
  readonly dryRun?: boolean;
  readonly concurrency?: number;
  readonly limit?: number;
  readonly onEvent?: (event: MigrationEvent) => void;
}

function defaultConcurrency(): number {
  return Math.min(4, Math.max(1, availableParallelism() - 1));
}

function hasImageExtension(key: string): boolean {
  return IMAGE_EXTENSIONS.has(parseKey(key).extension);
}

function describeError(error: unknown): { message: string; code: string | null } {
  if (error instanceof ImagePipelineError) {
    return { message: error.message, code: error.code };
  }
  if (error instanceof Error) {
    return { message: error.message, code: null };
  }
  return { message: String(error), code: null };
}

/**
 * Optimises every original already present in storage.
 *
 * Existing assets are never rewritten or deleted: the run reads from the
 * original prefix and only ever adds derivatives under the optimized prefix.
 * Re-running is safe, and a second run over unchanged sources does no encoding
 * at all.
 */
export async function runMigration(options: MigrationOptions): Promise<MigrationSummary> {
  const config = options.config ?? resolveImageConfig();
  const storage = options.storage;
  const dryRun = options.dryRun ?? false;
  const emit = options.onEvent ?? (() => undefined);

  const manifestLocation = manifestKey(config);
  const manifest = await loadManifest(storage, manifestLocation, (message) =>
    emit({ type: 'warning', message }),
  );

  const originalPrefix = `${config.originalPrefix}/`;
  const discovered = (await storage.list(config.originalPrefix))
    .filter((key) => key.startsWith(originalPrefix))
    .map((key) => key.slice(originalPrefix.length))
    .filter((key) => key !== '' && hasImageExtension(key))
    .filter((key) => options.keyPrefix === undefined || key.startsWith(options.keyPrefix))
    .sort();

  const keys = options.limit === undefined ? discovered : discovered.slice(0, options.limit);
  emit({ type: 'discovered', total: keys.length });

  const entries = new Map<string, ManifestEntry>(Object.entries(manifest.entries));
  const failures: MigrationFailure[] = [];
  let processed = 0;
  let skipped = 0;
  let planned = 0;
  let originalBytes = 0;
  let optimizedBytes = 0;
  let storedBytes = 0;
  let completed = 0;
  let sinceCheckpoint = 0;

  // Serialised so that two workers reaching a checkpoint together cannot
  // interleave their writes and publish a manifest missing the other's entries.
  let checkpointChain: Promise<void> = Promise.resolve();
  const persistCheckpoint = (): Promise<void> => {
    if (dryRun) return Promise.resolve();
    checkpointChain = checkpointChain.then(() =>
      saveManifest(storage, manifestLocation, {
        ...emptyManifest(),
        entries: Object.fromEntries(entries),
      }),
    );
    return checkpointChain;
  };

  const runOne = async (key: string, index: number): Promise<void> => {
    const source = await storage.get(`${config.originalPrefix}/${key}`);
    if (source === null) {
      throw new Error('Original disappeared between listing and reading.');
    }

    if (dryRun) {
      const plan = await planOptimization({
        key,
        source,
        storage,
        config,
        manifest,
        ...(options.force === undefined ? {} : { force: options.force }),
      });

      planned += plan.upToDate ? 0 : 1;
      skipped += plan.upToDate ? 1 : 0;
      originalBytes += plan.originalSize;
      emit({
        type: 'item',
        key,
        index,
        total: keys.length,
        status: plan.upToDate ? 'up-to-date' : 'planned',
        originalSize: plan.originalSize,
        optimizedSize: null,
      });
      return;
    }

    const result = await optimizeAndStore({
      key,
      source,
      storage,
      config,
      manifest,
      storeOriginal: false,
      ...(options.force === undefined ? {} : { force: options.force }),
    });

    if (result.entry !== null) entries.set(key, result.entry);

    originalBytes += result.record.originalSize;
    optimizedBytes += result.record.optimizedSize;
    storedBytes += result.record.storedBytes;
    if (result.status === 'processed') processed += 1;
    if (result.status === 'skipped') skipped += 1;

    emit({
      type: 'item',
      key,
      index,
      total: keys.length,
      status: result.status,
      originalSize: result.record.originalSize,
      optimizedSize: result.record.optimizedSize,
    });
  };

  const concurrency = Math.max(1, options.concurrency ?? defaultConcurrency());
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= keys.length) return;

      const key = keys[index] as string;
      try {
        await runOne(key, index + 1);
      } catch (error) {
        const { message, code } = describeError(error);
        failures.push({ key, message, code });
        emit({ type: 'failure', key, message });
      }

      completed += 1;
      sinceCheckpoint += 1;
      if (sinceCheckpoint >= CHECKPOINT_INTERVAL) {
        sinceCheckpoint = 0;
        await persistCheckpoint();
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, keys.length) }, worker));

  if (completed > 0) await persistCheckpoint();

  return {
    total: keys.length,
    processed,
    skipped,
    planned,
    failed: failures.length,
    originalBytes,
    optimizedBytes,
    storedBytes,
    failures,
    dryRun,
  };
}
