import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

import { StorageError } from '../errors.js';
import { assertSafeKey } from '../naming.js';
import type { PutOptions, StorageAdapter } from './types.js';

export interface LocalStorageOptions {
  /** Directory that holds every object. Created on demand. */
  readonly root: string;
  /**
   * Base URL the root is served from, used by `urlFor`. Defaults to `/`, which
   * suits a directory served straight out of a Next.js `public/` folder.
   */
  readonly baseUrl?: string;
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

/**
 * Filesystem-backed storage, used by the test suite and by local development.
 */
export class LocalStorageAdapter implements StorageAdapter {
  readonly name = 'local';

  readonly #root: string;
  readonly #baseUrl: string;

  constructor(options: LocalStorageOptions) {
    this.#root = path.resolve(options.root);
    this.#baseUrl = (options.baseUrl ?? '/').replace(/\/+$/, '');
  }

  /**
   * Second line of defence behind `assertSafeKey`. Even if a caller hands over
   * an unvalidated key, the resolved path is proven to stay under the root
   * before any filesystem call happens.
   */
  #resolve(key: string): string {
    assertSafeKey(key);

    const resolved = path.resolve(this.#root, key);
    const rootWithSeparator = this.#root.endsWith(path.sep) ? this.#root : this.#root + path.sep;

    if (resolved !== this.#root && !resolved.startsWith(rootWithSeparator)) {
      throw new StorageError(`Refusing to access "${key}" outside the storage root.`);
    }
    return resolved;
  }

  /**
   * Writes to a sibling temporary file and renames it into place, so a reader
   * never observes a half-written object and an interrupted write cannot leave
   * a truncated derivative that later looks complete.
   */
  async put(key: string, data: Buffer, _options: PutOptions): Promise<void> {
    const destination = this.#resolve(key);
    const directory = path.dirname(destination);

    try {
      await mkdir(directory, { recursive: true });

      const temporary = path.join(
        directory,
        `.${path.basename(destination)}.${randomBytes(6).toString('hex')}.tmp`,
      );
      try {
        await writeFile(temporary, data, { flag: 'wx' });
        await rename(temporary, destination);
      } catch (cause) {
        await rm(temporary, { force: true });
        throw cause;
      }
    } catch (cause) {
      throw new StorageError(`Failed to write "${key}".`, { cause });
    }
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.#resolve(key));
    } catch (cause) {
      if (isNotFound(cause)) return null;
      throw new StorageError(`Failed to read "${key}".`, { cause });
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      const stats = await stat(this.#resolve(key));
      return stats.isFile();
    } catch (cause) {
      if (isNotFound(cause)) return false;
      throw new StorageError(`Failed to stat "${key}".`, { cause });
    }
  }

  async list(prefix: string): Promise<string[]> {
    const directory = prefix === '' ? this.#root : this.#resolve(prefix);

    let entries;
    try {
      entries = await readdir(directory, { recursive: true, withFileTypes: true });
    } catch (cause) {
      if (isNotFound(cause)) return [];
      throw new StorageError(`Failed to list "${prefix}".`, { cause });
    }

    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => path.relative(this.#root, path.join(entry.parentPath, entry.name)))
      .map((relative) => relative.split(path.sep).join('/'))
      .sort();
  }

  urlFor(key: string): string {
    return `${this.#baseUrl}/${assertSafeKey(key)}`;
  }
}
