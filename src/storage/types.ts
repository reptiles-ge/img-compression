export interface PutOptions {
  readonly contentType: string;
}

/**
 * The pipeline's only contract with a storage backend.
 *
 * Keys are relative, slash-separated and already validated by `assertSafeKey`
 * before they reach an adapter; an adapter must still refuse to resolve outside
 * its own root, because it cannot assume its caller.
 *
 * HTTP cache headers are deliberately absent: on the production backend they
 * are owned by the CDN pull zone, not by the object.
 */
export interface StorageAdapter {
  /** Short identifier used in log lines and error messages. */
  readonly name: string;

  put(key: string, data: Buffer, options: PutOptions): Promise<void>;

  /** Resolves to `null` when the object does not exist. */
  get(key: string): Promise<Buffer | null>;

  exists(key: string): Promise<boolean>;

  /** Recursively lists object keys under `prefix`, excluding directories. */
  list(prefix: string): Promise<string[]>;

  /** The publicly reachable URL for a stored object. */
  urlFor(key: string): string;
}
