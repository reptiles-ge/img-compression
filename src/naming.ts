import { ImageValidationError } from './errors.js';
import type { ImageConfig } from './config.js';
import type { DerivativeFormat } from './formats.js';

// eslint-disable-next-line no-control-regex -- deliberately matching control characters
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/**
 * Rejects anything that could escape its prefix or confuse a filesystem. Keys
 * are relative, slash-separated and free of traversal segments; this is checked
 * before a key is ever joined onto a storage root.
 */
export function assertSafeKey(key: string): string {
  if (key === '') {
    throw new ImageValidationError('UNSAFE_KEY', 'Storage key must not be empty.');
  }
  if (CONTROL_CHARACTERS.test(key)) {
    throw new ImageValidationError('UNSAFE_KEY', 'Storage key must not contain control characters.');
  }
  if (key.includes('\\')) {
    throw new ImageValidationError('UNSAFE_KEY', 'Storage key must use "/" as its separator.');
  }
  if (key.startsWith('/')) {
    throw new ImageValidationError('UNSAFE_KEY', 'Storage key must be relative.');
  }
  if (/^[A-Za-z]:/.test(key)) {
    throw new ImageValidationError('UNSAFE_KEY', 'Storage key must not be a drive-qualified path.');
  }

  const segments = key.split('/');
  for (const segment of segments) {
    if (segment === '') {
      throw new ImageValidationError('UNSAFE_KEY', 'Storage key must not contain empty segments.');
    }
    if (segment === '.' || segment === '..') {
      throw new ImageValidationError('UNSAFE_KEY', 'Storage key must not contain traversal segments.');
    }
  }

  return key;
}

export interface ParsedKey {
  /** Directory portion without a trailing slash, or `''` at the root. */
  readonly directory: string;
  /** File name without its extension. */
  readonly baseName: string;
  /** Lowercase extension without the leading dot, or `''` when absent. */
  readonly extension: string;
}

export function parseKey(key: string): ParsedKey {
  assertSafeKey(key);

  const lastSlash = key.lastIndexOf('/');
  const directory = lastSlash === -1 ? '' : key.slice(0, lastSlash);
  const fileName = lastSlash === -1 ? key : key.slice(lastSlash + 1);

  const lastDot = fileName.lastIndexOf('.');
  const hasExtension = lastDot > 0;

  return {
    directory,
    baseName: hasExtension ? fileName.slice(0, lastDot) : fileName,
    extension: hasExtension ? fileName.slice(lastDot + 1).toLowerCase() : '',
  };
}

function joinKey(...parts: readonly string[]): string {
  return parts.filter((part) => part !== '').join('/');
}

/**
 * Turns an untrusted upload file name into a conservative ASCII storage key
 * segment. Never used for existing assets, whose keys are preserved verbatim.
 */
export function slugifyFileName(fileName: string, fallback = 'image'): string {
  const withoutDirectories = fileName.split(/[\\/]/).pop() ?? fileName;
  const lastDot = withoutDirectories.lastIndexOf('.');
  const stem = lastDot > 0 ? withoutDirectories.slice(0, lastDot) : withoutDirectories;

  const slug = stem
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');

  return slug === '' ? fallback : slug;
}

export function originalKey(config: ImageConfig, key: string): string {
  return joinKey(config.originalPrefix, assertSafeKey(key));
}

/**
 * Derivative names always carry their width, so output names stay stable and
 * predictable when the width ladder changes: `snake.jpg` at 2400px becomes
 * `optimized/snake-2400.avif`.
 */
export function derivativeKey(
  config: ImageConfig,
  key: string,
  width: number,
  format: DerivativeFormat,
): string {
  const { directory, baseName } = parseKey(key);
  return joinKey(config.optimizedPrefix, directory, `${baseName}-${width}.${format}`);
}

export function manifestKey(config: ImageConfig): string {
  return joinKey(config.optimizedPrefix, 'manifest.json');
}
