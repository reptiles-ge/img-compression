import { createHash } from 'node:crypto';

import type { DerivativeFormat } from './formats.js';
import { StorageError } from './errors.js';
import type { StorageAdapter } from './storage/types.js';

export const MANIFEST_VERSION = 1;

export interface ManifestDerivative {
  readonly key: string;
  readonly format: DerivativeFormat;
  readonly width: number;
  readonly height: number;
  readonly byteSize: number;
}

export interface ManifestEntry {
  /** SHA-256 of the original bytes; changes when the source is replaced. */
  readonly sourceHash: string;
  /** Fingerprint of the encoding settings that produced these derivatives. */
  readonly configFingerprint: string;
  readonly originalKey: string;
  readonly originalSize: number;
  readonly width: number;
  readonly height: number;
  readonly derivatives: readonly ManifestDerivative[];
  readonly updatedAt: string;
}

export interface Manifest {
  readonly version: number;
  readonly entries: Readonly<Record<string, ManifestEntry>>;
}

export function emptyManifest(): Manifest {
  return { version: MANIFEST_VERSION, entries: {} };
}

export function hashSource(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function isManifestEntry(value: unknown): value is ManifestEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry['sourceHash'] === 'string' &&
    typeof entry['configFingerprint'] === 'string' &&
    typeof entry['originalKey'] === 'string' &&
    Array.isArray(entry['derivatives'])
  );
}

/**
 * Reads the manifest, treating an absent or unreadable one as empty.
 *
 * A corrupt manifest must not stop a migration: the worst consequence of
 * ignoring it is that already-optimised images are regenerated, which is
 * wasteful but produces identical output.
 */
export async function loadManifest(
  storage: StorageAdapter,
  key: string,
  onWarning?: (message: string) => void,
): Promise<Manifest> {
  let raw: Buffer | null;
  try {
    raw = await storage.get(key);
  } catch (cause) {
    throw new StorageError(`Failed to read the manifest at "${key}".`, { cause });
  }
  if (raw === null) return emptyManifest();

  try {
    const parsed: unknown = JSON.parse(raw.toString('utf8'));
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      (parsed as { version?: unknown }).version !== MANIFEST_VERSION
    ) {
      onWarning?.(`Manifest at "${key}" has an unexpected version and will be rebuilt.`);
      return emptyManifest();
    }

    const rawEntries = (parsed as { entries?: unknown }).entries;
    if (typeof rawEntries !== 'object' || rawEntries === null) return emptyManifest();

    const entries: Record<string, ManifestEntry> = {};
    for (const [entryKey, value] of Object.entries(rawEntries)) {
      if (isManifestEntry(value)) entries[entryKey] = value;
    }
    return { version: MANIFEST_VERSION, entries };
  } catch {
    onWarning?.(`Manifest at "${key}" could not be parsed and will be rebuilt.`);
    return emptyManifest();
  }
}

export async function saveManifest(
  storage: StorageAdapter,
  key: string,
  manifest: Manifest,
): Promise<void> {
  // Keys are sorted so that repeated runs produce byte-identical manifests and
  // a diff only ever shows genuine changes.
  const sortedEntries = Object.fromEntries(
    Object.entries(manifest.entries).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  const body = JSON.stringify({ version: MANIFEST_VERSION, entries: sortedEntries }, null, 2);

  await storage.put(key, Buffer.from(body, 'utf8'), { contentType: 'application/json' });
}

/**
 * True when the recorded entry was produced from the same bytes with the same
 * settings, and the original plus every derivative it names is still present.
 *
 * Checking presence rather than trusting the manifest alone means that deleting
 * an asset from storage is enough to have the next run rebuild it.
 */
export async function isEntryFresh(
  entry: ManifestEntry | undefined,
  sourceHash: string,
  configFingerprint: string,
  storage: StorageAdapter,
): Promise<boolean> {
  if (entry === undefined) return false;
  if (entry.sourceHash !== sourceHash) return false;
  if (entry.configFingerprint !== configFingerprint) return false;
  if (entry.derivatives.length === 0) return false;

  const required = [entry.originalKey, ...entry.derivatives.map((derivative) => derivative.key)];
  const presence = await Promise.all(required.map((key) => storage.exists(key)));
  return presence.every(Boolean);
}
