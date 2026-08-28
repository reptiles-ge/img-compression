# Contributing

Thanks for taking an interest in this project. It powers image delivery for
[Reptiles.ge](https://reptiles.ge), so changes are reviewed with production in
mind.

## Getting set up

```bash
npm ci
npm test
```

Node 20.11 or newer is required. `sharp` ships prebuilt binaries, so no native
toolchain is needed on a supported platform.

## Before opening a pull request

Run what CI runs:

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
```

## What reviewers look for

The priority order for this repository is **correctness, then security, then
maintainability, then performance, then simplicity**. A change that makes files
smaller at the cost of visible quality, or faster at the cost of safety, will
be sent back.

Specific things that will be checked:

- **Originals are never modified or deleted.** The original is the canonical
  asset. Every derivative must be reproducible from it.
- **Untrusted input stays untrusted.** Format, size and dimensions come from
  the decoded image, never from a file name or a client-supplied header.
- **Processing stays idempotent.** The same source and configuration must
  produce the same output, and a repeat run must not re-encode or duplicate.
- **No new runtime dependencies without justification.** See below.
- **No magic numbers.** Anything affecting output belongs in `src/config.ts`.

## Changing encoder settings

Quality defaults are set from measurements, not preference. If you propose a
change, include the numbers:

```bash
npm run images:benchmark            # current settings against real photographs
npm run images:benchmark -- --sweep # candidate settings side by side
```

The benchmark downloads the site's own photographs into `benchmarks/fixtures/`,
which is git-ignored. Do not commit image files.

If a change alters the bytes produced without any configuration change, bump
`PIPELINE_VERSION` in `src/config.ts` so existing derivatives are invalidated.

## Adding a dependency

Runtime dependencies are kept to `sharp` deliberately. Before proposing another,
please establish that:

1. The functionality is not already available in Node or in `sharp`.
2. The package is maintained and has a credible security history.
3. Its licence is compatible with MIT — see [docs/licensing.md](docs/licensing.md).
4. It does not pull a native binary or a large transitive tree.

Development-only dependencies are judged less strictly, but still need a reason.

## Commit messages

Conventional commits, with a body that explains _why_:

```
feat: add AVIF derivative generation
fix: reject animated WebP before it collapses to one frame
docs: explain the migration workflow
```

## Reporting a vulnerability

Please do not open a public issue. See [SECURITY.md](SECURITY.md).
