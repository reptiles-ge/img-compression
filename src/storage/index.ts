import { ConfigurationError } from '../errors.js';
import { BunnyStorageAdapter } from './bunny.js';
import { LocalStorageAdapter } from './local.js';
import type { StorageAdapter } from './types.js';

export { BunnyStorageAdapter, type BunnyStorageOptions } from './bunny.js';
export { LocalStorageAdapter, type LocalStorageOptions } from './local.js';
export type { PutOptions, StorageAdapter } from './types.js';

/** Environment variables recognised by {@link createStorageFromEnv}. */
export interface StorageEnv {
  IMAGE_STORAGE_DRIVER?: string | undefined;
  IMAGE_LOCAL_STORAGE_ROOT?: string | undefined;
  IMAGE_LOCAL_STORAGE_BASE_URL?: string | undefined;
  BUNNY_STORAGE_ZONE?: string | undefined;
  BUNNY_STORAGE_ACCESS_KEY?: string | undefined;
  BUNNY_STORAGE_REGION?: string | undefined;
  BUNNY_CDN_BASE_URL?: string | undefined;
}

function required(env: StorageEnv, name: keyof StorageEnv): string {
  const value = env[name];
  if (value === undefined || value.trim() === '') {
    throw new ConfigurationError(`${name} must be set to use the Bunny storage driver.`);
  }
  return value;
}

/**
 * Builds the adapter named by `IMAGE_STORAGE_DRIVER`, defaulting to `local` so
 * that a developer with no credentials can still run the pipeline end to end.
 */
export function createStorageFromEnv(env: StorageEnv = process.env): StorageAdapter {
  const driver = (env.IMAGE_STORAGE_DRIVER ?? 'local').trim().toLowerCase();

  switch (driver) {
    case 'local':
      return new LocalStorageAdapter({
        root: env.IMAGE_LOCAL_STORAGE_ROOT ?? 'public/media',
        ...(env.IMAGE_LOCAL_STORAGE_BASE_URL === undefined
          ? {}
          : { baseUrl: env.IMAGE_LOCAL_STORAGE_BASE_URL }),
      });

    case 'bunny':
      return new BunnyStorageAdapter({
        storageZone: required(env, 'BUNNY_STORAGE_ZONE'),
        accessKey: required(env, 'BUNNY_STORAGE_ACCESS_KEY'),
        cdnBaseUrl: required(env, 'BUNNY_CDN_BASE_URL'),
        ...(env.BUNNY_STORAGE_REGION === undefined ? {} : { region: env.BUNNY_STORAGE_REGION }),
      });

    default:
      throw new ConfigurationError(
        `Unknown IMAGE_STORAGE_DRIVER "${driver}". Expected "local" or "bunny".`,
      );
  }
}
