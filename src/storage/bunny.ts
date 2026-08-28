import { createHash } from 'node:crypto';

import { ConfigurationError, StorageError } from '../errors.js';
import { assertSafeKey } from '../naming.js';
import type { PutOptions, StorageAdapter } from './types.js';

/**
 * Bunny replicates a storage zone to one primary region. An empty string
 * targets the default Falkenstein endpoint, matching Bunny's own convention.
 */
const REGION_HOSTS: Readonly<Record<string, string>> = {
  '': 'storage.bunnycdn.com',
  de: 'storage.bunnycdn.com',
  uk: 'uk.storage.bunnycdn.com',
  ny: 'ny.storage.bunnycdn.com',
  la: 'la.storage.bunnycdn.com',
  sg: 'sg.storage.bunnycdn.com',
  se: 'se.storage.bunnycdn.com',
  br: 'br.storage.bunnycdn.com',
  jh: 'jh.storage.bunnycdn.com',
  syd: 'syd.storage.bunnycdn.com',
};

export interface BunnyStorageOptions {
  readonly storageZone: string;
  /** Storage zone password. Server-side only; never expose it to a browser. */
  readonly accessKey: string;
  /** Region code such as `de` or `ny`. Defaults to the primary endpoint. */
  readonly region?: string;
  /** Public pull-zone origin, for example `https://cdn.reptiles.ge`. */
  readonly cdnBaseUrl: string;
  /** Attempts per request, including the first. Defaults to 3. */
  readonly maxAttempts?: number;
  readonly fetchImpl?: typeof fetch;
}

interface BunnyListEntry {
  readonly ObjectName?: unknown;
  readonly IsDirectory?: unknown;
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Bunny Edge Storage, the origin behind `cdn.reptiles.ge`.
 *
 * Implemented directly against the REST API with the global `fetch` rather than
 * Bunny's SDK: the surface we need is three verbs, and this avoids adding a
 * dependency to a package that already ships a native binary.
 */
export class BunnyStorageAdapter implements StorageAdapter {
  readonly name = 'bunny';

  readonly #origin: string;
  readonly #storageZone: string;
  readonly #accessKey: string;
  readonly #cdnBaseUrl: string;
  readonly #maxAttempts: number;
  readonly #fetch: typeof fetch;
  readonly #directoryCache = new Map<string, { files: Set<string>; directories: Set<string> }>();

  constructor(options: BunnyStorageOptions) {
    const region = (options.region ?? '').trim().toLowerCase();
    const host = REGION_HOSTS[region];
    if (host === undefined) {
      throw new ConfigurationError(
        `Unknown Bunny storage region "${region}". Expected one of: ` +
          Object.keys(REGION_HOSTS)
            .filter((value) => value !== '')
            .join(', '),
      );
    }

    if (options.storageZone.trim() === '') {
      throw new ConfigurationError('Bunny storage zone must not be empty.');
    }
    if (options.accessKey.trim() === '') {
      throw new ConfigurationError('Bunny storage access key must not be empty.');
    }

    let cdnBaseUrl: URL;
    try {
      cdnBaseUrl = new URL(options.cdnBaseUrl);
    } catch (cause) {
      throw new ConfigurationError('Bunny CDN base URL is not a valid URL.', { cause });
    }
    if (cdnBaseUrl.protocol !== 'https:' && cdnBaseUrl.protocol !== 'http:') {
      throw new ConfigurationError('Bunny CDN base URL must use http or https.');
    }

    this.#origin = `https://${host}`;
    this.#storageZone = options.storageZone.trim();
    this.#accessKey = options.accessKey;
    this.#cdnBaseUrl = cdnBaseUrl.toString().replace(/\/+$/, '');
    this.#maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
  }

  #url(key: string): string {
    const encoded = key
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');
    return `${this.#origin}/${encodeURIComponent(this.#storageZone)}/${encoded}`;
  }

  /**
   * Retries only on transport failures and the status codes Bunny uses for
   * transient conditions. A 4xx is a permanent answer and is surfaced at once.
   *
   * Errors never include the request headers, so the access key cannot reach a
   * log or an error report through this path.
   */
  async #request(url: string, init: RequestInit, description: string): Promise<Response> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      let response: Response;
      try {
        response = await this.#fetch(url, {
          ...init,
          headers: { ...init.headers, AccessKey: this.#accessKey },
        });
      } catch (cause) {
        lastError = cause;
        if (attempt === this.#maxAttempts) break;
        await delay(250 * 2 ** (attempt - 1));
        continue;
      }

      if (!RETRYABLE_STATUS.has(response.status) || attempt === this.#maxAttempts) {
        return response;
      }

      lastError = new StorageError(`${description} responded with HTTP ${response.status}.`);
      await response.body?.cancel();
      await delay(250 * 2 ** (attempt - 1));
    }

    throw new StorageError(`${description} failed after ${this.#maxAttempts} attempts.`, {
      cause: lastError,
    });
  }

  async put(key: string, data: Buffer, options: PutOptions): Promise<void> {
    assertSafeKey(key);

    const response = await this.#request(
      this.#url(key),
      {
        method: 'PUT',
        body: new Uint8Array(data),
        headers: {
          'Content-Type': options.contentType,
          // Bunny verifies this server-side and rejects a corrupted upload,
          // which keeps a truncated transfer from becoming a broken derivative.
          Checksum: createHash('sha256').update(data).digest('hex').toUpperCase(),
        },
      },
      `Uploading "${key}"`,
    );

    if (!response.ok) {
      throw new StorageError(`Failed to upload "${key}": HTTP ${response.status}.`);
    }
    this.#rememberWrite(key);
  }

  async get(key: string): Promise<Buffer | null> {
    assertSafeKey(key);

    const response = await this.#request(this.#url(key), { method: 'GET' }, `Downloading "${key}"`);

    if (response.status === 404) return null;
    if (!response.ok) {
      throw new StorageError(`Failed to download "${key}": HTTP ${response.status}.`);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  /**
   * Bunny exposes no HEAD verb for storage objects, so existence is answered
   * from the parent directory listing. Listings are memoised per adapter
   * instance and updated on write, which keeps a migration run to one request
   * per directory instead of one per object.
   */
  async exists(key: string): Promise<boolean> {
    assertSafeKey(key);

    const lastSlash = key.lastIndexOf('/');
    const directory = lastSlash === -1 ? '' : key.slice(0, lastSlash);
    const fileName = lastSlash === -1 ? key : key.slice(lastSlash + 1);

    const names = await this.#listDirectory(directory);
    return names.files.has(fileName);
  }

  async list(prefix: string): Promise<string[]> {
    const normalized = prefix.replace(/^\/+|\/+$/g, '');
    const collected: string[] = [];
    const queue = [normalized];

    while (queue.length > 0) {
      const directory = queue.shift() as string;
      const { files, directories } = await this.#listDirectory(directory);

      for (const file of files) {
        collected.push(directory === '' ? file : `${directory}/${file}`);
      }
      for (const child of directories) {
        queue.push(directory === '' ? child : `${directory}/${child}`);
      }
    }

    return collected.sort();
  }

  urlFor(key: string): string {
    const encoded = assertSafeKey(key)
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');
    return `${this.#cdnBaseUrl}/${encoded}`;
  }

  async #listDirectory(
    directory: string,
  ): Promise<{ files: Set<string>; directories: Set<string> }> {
    const cached = this.#directoryCache.get(directory);
    if (cached !== undefined) return cached;

    const url = directory === '' ? `${this.#url('')}` : `${this.#url(directory)}/`;
    const response = await this.#request(url, { method: 'GET' }, `Listing "${directory}"`);

    const entry = { files: new Set<string>(), directories: new Set<string>() };

    if (response.status === 404) {
      this.#directoryCache.set(directory, entry);
      return entry;
    }
    if (!response.ok) {
      throw new StorageError(`Failed to list "${directory}": HTTP ${response.status}.`);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (cause) {
      throw new StorageError(`Listing "${directory}" returned a malformed response.`, { cause });
    }
    if (!Array.isArray(payload)) {
      throw new StorageError(`Listing "${directory}" returned an unexpected payload.`);
    }

    for (const item of payload as BunnyListEntry[]) {
      const name = item.ObjectName;
      if (typeof name !== 'string' || name === '') continue;
      if (item.IsDirectory === true) {
        entry.directories.add(name);
      } else {
        entry.files.add(name);
      }
    }

    this.#directoryCache.set(directory, entry);
    return entry;
  }

  /** Keeps the listing cache truthful after a write within the same run. */
  #rememberWrite(key: string): void {
    const lastSlash = key.lastIndexOf('/');
    const directory = lastSlash === -1 ? '' : key.slice(0, lastSlash);
    const fileName = lastSlash === -1 ? key : key.slice(lastSlash + 1);
    this.#directoryCache.get(directory)?.files.add(fileName);
  }
}
