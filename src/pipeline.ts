import { configFingerprint, resolveImageConfig, targetWidthsFor, type ImageConfig } from './config.js';
import { DERIVATIVE_FORMATS, INPUT_MIME_TYPES, MIME_TYPES, type DerivativeFormat } from './formats.js';
import {
  hashSource,
  isEntryFresh,
  type Manifest,
  type ManifestDerivative,
  type ManifestEntry,
} from './manifest.js';
import { assertSafeKey, derivativeKey, originalKey } from './naming.js';
import { processImage } from './processor.js';
import type { StorageAdapter } from './storage/types.js';
import { validateSource } from './validate.js';

export interface StoredDerivative extends ManifestDerivative {
  readonly url: string;
}

/**
 * Everything the application needs to persist and render an image.
 *
 * `optimizedSize` is the transfer size a modern browser pays at full width,
 * i.e. the largest AVIF. `storedBytes` is what the pipeline occupies in
 * storage across every derivative.
 */
export interface OptimizedImageRecord {
  readonly key: string;
  readonly originalKey: string;
  readonly originalUrl: string;
  readonly originalSize: number;
  /** Intrinsic dimensions of the largest derivative, for width/height attributes. */
  readonly width: number;
  readonly height: number;
  readonly derivatives: readonly StoredDerivative[];
  readonly avifUrl: string;
  readonly webpUrl: string;
  readonly optimizedSize: number;
  readonly storedBytes: number;
}

export type OptimizeStatus = 'processed' | 'skipped' | 'processing-disabled';

export interface OptimizeResult {
  readonly status: OptimizeStatus;
  readonly record: OptimizedImageRecord;
  /** Absent only when processing is disabled and nothing was derived. */
  readonly entry: ManifestEntry | null;
}

export interface OptimizeInput {
  /**
   * Logical key for the image, relative and slash-separated, including its
   * original extension: `species/vipera-lebetina.jpg`. Prefixes are applied by
   * the pipeline, so this must not already contain them.
   */
  readonly key: string;
  readonly source: Buffer;
  readonly storage: StorageAdapter;
  readonly config?: ImageConfig;
  /** Manifest to consult for idempotency. Omit to always process. */
  readonly manifest?: Manifest;
  /** Reprocess even when the manifest says the derivatives are current. */
  readonly force?: boolean;
  /**
   * Whether to write the original. Uploads need this; a migration reading its
   * sources from the original prefix does not, and would only rewrite bytes
   * that are already in place.
   */
  readonly storeOriginal?: boolean;
}

function buildRecord(
  key: string,
  entry: ManifestEntry,
  storage: StorageAdapter,
): OptimizedImageRecord {
  const derivatives: StoredDerivative[] = entry.derivatives.map((derivative) => ({
    ...derivative,
    url: storage.urlFor(derivative.key),
  }));

  const largestOf = (format: DerivativeFormat): StoredDerivative | undefined =>
    derivatives.filter((derivative) => derivative.format === format).at(-1);

  const largestAvif = largestOf('avif');
  const largestWebp = largestOf('webp');

  return {
    key,
    originalKey: entry.originalKey,
    originalUrl: storage.urlFor(entry.originalKey),
    originalSize: entry.originalSize,
    width: entry.width,
    height: entry.height,
    derivatives,
    avifUrl: largestAvif?.url ?? storage.urlFor(entry.originalKey),
    webpUrl: largestWebp?.url ?? storage.urlFor(entry.originalKey),
    optimizedSize: largestAvif?.byteSize ?? entry.originalSize,
    storedBytes: derivatives.reduce((total, derivative) => total + derivative.byteSize, 0),
  };
}

/**
 * Validates untrusted bytes, derives AVIF and WebP at every applicable width,
 * and stores the original alongside them.
 *
 * Encoding happens before anything is written. Header validation alone cannot
 * prove an image decodes -- a truncated JPEG has a perfectly valid header --
 * so only a full decode establishes that the bytes are a real image. Storing
 * the original first would mean publishing unverified, attacker-supplied bytes
 * to a public CDN and leaving an asset behind that every later run fails on.
 *
 * The consequence is that a failed call stores nothing at all, and never
 * deletes or modifies anything either: the caller still holds the source bytes
 * and receives a typed error describing what went wrong. Once encoding has
 * succeeded, the original is written before its derivatives, so a partial set
 * is never published without its canonical source.
 */
export async function optimizeAndStore(input: OptimizeInput): Promise<OptimizeResult> {
  const config = input.config ?? resolveImageConfig();
  const key = assertSafeKey(input.key);
  const storage = input.storage;
  const storeOriginal = input.storeOriginal ?? true;

  const targetOriginalKey = originalKey(config, key);
  const sourceHash = hashSource(input.source);
  const fingerprint = configFingerprint(config);

  const existing = input.manifest?.entries[key];
  if (
    existing !== undefined &&
    input.force !== true &&
    (await isEntryFresh(existing, sourceHash, fingerprint, storage))
  ) {
    return { status: 'skipped', record: buildRecord(key, existing, storage), entry: existing };
  }

  if (!config.enabled) {
    const probe = await validateSource(input.source, config);
    if (storeOriginal) {
      await storage.put(targetOriginalKey, input.source, {
        contentType: INPUT_MIME_TYPES[probe.format],
      });
    }

    const entry: ManifestEntry = {
      sourceHash,
      configFingerprint: fingerprint,
      originalKey: targetOriginalKey,
      originalSize: input.source.byteLength,
      width: 0,
      height: 0,
      derivatives: [],
      updatedAt: new Date().toISOString(),
    };
    return {
      status: 'processing-disabled',
      record: buildRecord(key, entry, storage),
      entry: null,
    };
  }

  const processed = await processImage(input.source, config);

  if (storeOriginal) {
    await storage.put(targetOriginalKey, input.source, {
      contentType: INPUT_MIME_TYPES[processed.source.format],
    });
  }

  const stored: ManifestDerivative[] = [];
  for (const derivative of processed.derivatives) {
    const outputKey = derivativeKey(config, key, derivative.width, derivative.format);
    await storage.put(outputKey, derivative.data, {
      contentType: MIME_TYPES[derivative.format],
    });
    stored.push({
      key: outputKey,
      format: derivative.format,
      width: derivative.width,
      height: derivative.height,
      byteSize: derivative.byteSize,
    });
  }

  const entry: ManifestEntry = {
    sourceHash,
    configFingerprint: fingerprint,
    originalKey: targetOriginalKey,
    originalSize: input.source.byteLength,
    width: processed.width,
    height: processed.height,
    derivatives: stored,
    updatedAt: new Date().toISOString(),
  };

  return { status: 'processed', record: buildRecord(key, entry, storage), entry };
}

export interface PlannedDerivative {
  readonly key: string;
  readonly format: DerivativeFormat;
  readonly width: number;
}

export interface OptimizationPlan {
  readonly key: string;
  readonly originalKey: string;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly originalSize: number;
  /** True when the manifest already covers these bytes and settings. */
  readonly upToDate: boolean;
  readonly derivatives: readonly PlannedDerivative[];
}

/**
 * Answers what a run would do without encoding anything.
 *
 * Only the image header is read, so planning a large migration costs a header
 * parse per image instead of an AVIF encode per image. That is the whole point
 * of `--dry-run`: it is cheap enough to run before a real migration.
 */
export async function planOptimization(
  input: Omit<OptimizeInput, 'storeOriginal'>,
): Promise<OptimizationPlan> {
  const config = input.config ?? resolveImageConfig();
  const key = assertSafeKey(input.key);

  const source = await validateSource(input.source, config);

  const sourceHash = hashSource(input.source);
  const fingerprint = configFingerprint(config);
  const existing = input.manifest?.entries[key];
  const upToDate =
    input.force !== true && (await isEntryFresh(existing, sourceHash, fingerprint, input.storage));

  const derivatives = targetWidthsFor(config, source.width).flatMap((width) =>
    DERIVATIVE_FORMATS.map((format) => ({
      key: derivativeKey(config, key, width, format),
      format,
      width,
    })),
  );

  return {
    key,
    originalKey: originalKey(config, key),
    sourceWidth: source.width,
    sourceHeight: source.height,
    originalSize: input.source.byteLength,
    upToDate,
    derivatives,
  };
}
