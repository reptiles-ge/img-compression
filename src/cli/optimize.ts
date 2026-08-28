#!/usr/bin/env node
import { resolveImageConfig } from '../config.js';
import { ImagePipelineError } from '../errors.js';
import { runMigration, type MigrationEvent, type MigrationSummary } from '../migrate.js';
import { createStorageFromEnv } from '../storage/index.js';

interface CliOptions {
  readonly dryRun: boolean;
  readonly force: boolean;
  readonly quiet: boolean;
  readonly concurrency: number | undefined;
  readonly limit: number | undefined;
  readonly keyPrefix: string | undefined;
}

const USAGE = `
Optimise the originals already held in storage, producing AVIF and WebP
derivatives alongside them. Originals are never modified or deleted.

Usage:
  reptiles-images [options]

Options:
  --dry-run            Report what would change without encoding or writing.
  --force              Reprocess even when the manifest says assets are current.
  --prefix <path>      Only handle keys beginning with this logical prefix.
  --limit <n>          Stop after n images. Useful for a first trial run.
  --concurrency <n>    Images processed in parallel. Defaults to CPU count - 1, capped at 4.
  --quiet              Only print the final summary.
  -h, --help           Show this message.

Storage and quality are configured through the environment; see docs/configuration.md.
`.trim();

function parseCount(flag: string, raw: string | undefined): number {
  const value = Number(raw);
  if (raw === undefined || !Number.isInteger(value) || value < 1) {
    throw new Error(`${flag} requires a positive integer.`);
  }
  return value;
}

function parseArguments(argv: readonly string[]): CliOptions | 'help' {
  let dryRun = false;
  let force = false;
  let quiet = false;
  let concurrency: number | undefined;
  let limit: number | undefined;
  let keyPrefix: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case '--help':
      case '-h':
        return 'help';
      case '--dry-run':
        dryRun = true;
        break;
      case '--force':
        force = true;
        break;
      case '--quiet':
        quiet = true;
        break;
      case '--concurrency':
        index += 1;
        concurrency = parseCount('--concurrency', argv[index]);
        break;
      case '--limit':
        index += 1;
        limit = parseCount('--limit', argv[index]);
        break;
      case '--prefix': {
        index += 1;
        const value = argv[index];
        if (value === undefined || value === '') {
          throw new Error('--prefix requires a value.');
        }
        keyPrefix = value;
        break;
      }
      default:
        throw new Error(`Unknown argument "${argument ?? ''}". Try --help.`);
    }
  }

  return { dryRun, force, quiet, concurrency, limit, keyPrefix };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function reportEvent(event: MigrationEvent, quiet: boolean): void {
  switch (event.type) {
    case 'discovered':
      if (!quiet) console.log(`Found ${event.total} original image(s).`);
      break;
    case 'item': {
      if (quiet) return;
      const position = `[${event.index}/${event.total}]`;
      const saving =
        event.optimizedSize === null || event.originalSize === 0
          ? ''
          : ` ${formatBytes(event.originalSize)} -> ${formatBytes(event.optimizedSize)}` +
            ` (${(100 - (event.optimizedSize / event.originalSize) * 100).toFixed(1)}% smaller)`;
      console.log(`${position} ${event.status.padEnd(19)} ${event.key}${saving}`);
      break;
    }
    case 'failure':
      console.error(`  failed             ${event.key}: ${event.message}`);
      break;
    case 'warning':
      console.warn(`  warning            ${event.message}`);
      break;
  }
}

function reportSummary(summary: MigrationSummary): void {
  console.log('');
  if (summary.dryRun) {
    console.log(
      `Dry run: ${summary.planned} image(s) would be processed, ` +
        `${summary.skipped} already up to date, ${summary.failed} unreadable.`,
    );
    console.log('No files were written.');
  } else {
    console.log(
      `Processed ${summary.processed}, skipped ${summary.skipped}, failed ${summary.failed} ` +
        `of ${summary.total} image(s).`,
    );
    if (summary.originalBytes > 0) {
      const ratio = 100 - (summary.optimizedBytes / summary.originalBytes) * 100;
      console.log(
        `Originals ${formatBytes(summary.originalBytes)}, ` +
          `AVIF at full width ${formatBytes(summary.optimizedBytes)} (${ratio.toFixed(1)}% smaller).`,
      );
      console.log(`Derivatives occupy ${formatBytes(summary.storedBytes)} in storage.`);
    }
  }

  if (summary.failures.length > 0) {
    console.log('');
    console.log('Failures:');
    for (const failure of summary.failures) {
      console.log(
        `  ${failure.key}: ${failure.message}${failure.code === null ? '' : ` [${failure.code}]`}`,
      );
    }
  }
}

async function main(): Promise<number> {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed === 'help') {
    console.log(USAGE);
    return 0;
  }

  const config = resolveImageConfig();
  const storage = createStorageFromEnv();

  if (!config.enabled && !parsed.dryRun) {
    console.error(
      'IMAGE_PROCESSING_ENABLED is false; refusing to run a migration that would derive nothing.',
    );
    return 1;
  }

  console.log(
    `Storage: ${storage.name}. Widths: ${[...config.additionalWidths, config.maxWidth].join(', ')}. ` +
      `AVIF q${config.avifQuality}, WebP q${config.webpQuality}.`,
  );

  const summary = await runMigration({
    storage,
    config,
    force: parsed.force,
    dryRun: parsed.dryRun,
    ...(parsed.concurrency === undefined ? {} : { concurrency: parsed.concurrency }),
    ...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
    ...(parsed.keyPrefix === undefined ? {} : { keyPrefix: parsed.keyPrefix }),
    onEvent: (event) => reportEvent(event, parsed.quiet),
  });

  reportSummary(summary);
  return summary.failed > 0 ? 1 : 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    if (error instanceof ImagePipelineError) {
      console.error(`${error.code}: ${error.message}`);
    } else {
      console.error(error instanceof Error ? error.message : String(error));
    }
    process.exitCode = 1;
  });
