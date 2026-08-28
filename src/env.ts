import { ConfigurationError } from './errors.js';

/**
 * Parsing and validation shared by every configuration resolver, so a setting
 * is rejected the same way whichever resolver owns it.
 */

export function parseInteger(name: string, raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw.trim());
  if (!Number.isInteger(value)) {
    throw new ConfigurationError(`${name} must be an integer, received "${raw}".`);
  }
  return value;
}

export function parseBoolean(name: string, raw: string | undefined): boolean | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  throw new ConfigurationError(`${name} must be a boolean, received "${raw}".`);
}

export function parseWidthList(name: string, raw: string | undefined): number[] | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map((part) => {
      const value = Number(part);
      if (!Number.isInteger(value)) {
        throw new ConfigurationError(
          `${name} must be a comma-separated list of integers, received "${raw}".`,
        );
      }
      return value;
    });
}

export function assertRange(name: string, value: number, min: number, max: number): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigurationError(`${name} must be an integer between ${min} and ${max}.`);
  }
}

/**
 * Normalises a storage prefix to a relative, slash-separated path.
 *
 * A leading slash is stripped rather than rejected, because storage keys are
 * always relative and a leading slash is a stray character rather than an
 * attempt to reach the filesystem. Traversal segments are rejected outright.
 */
export function normalizePrefix(name: string, prefix: string): string {
  const trimmed = prefix.trim().replace(/^\/+|\/+$/g, '');
  if (trimmed === '') {
    throw new ConfigurationError(`${name} must not be empty.`);
  }
  if (
    !/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(trimmed) ||
    trimmed.split('/').includes('..')
  ) {
    throw new ConfigurationError(
      `${name} must be a relative slash-separated path of [A-Za-z0-9._-] segments.`,
    );
  }
  return trimmed;
}
