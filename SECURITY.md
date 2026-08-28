# Security Policy

## Supported versions

The `main` branch is the supported version. Fixes are released from it.

## Reporting a vulnerability

Please report privately rather than in a public issue, so that a fix can be
prepared before the details are public.

Use GitHub's [private vulnerability reporting](https://github.com/reptiles-ge/img-compression/security/advisories/new)
on this repository.

Please include what you can: affected version, a description of the impact, and
steps or a sample file that reproduces it. If a proof-of-concept image is
involved, describe it rather than attaching it to a public thread.

You can expect an acknowledgement within a few days. We will keep you informed
while a fix is prepared and will credit you in the advisory unless you prefer
otherwise.

## Threat model

This package decodes images that users upload. Its guards assume the input is
hostile:

- Format is determined by decoding the image, never from the file name or a
  client-supplied content type.
- Payload size is capped before any decode is attempted.
- Decoded pixel count and per-side dimensions are capped, which bounds both
  decompression bombs and pathological aspect ratios.
- Encoding runs under a wall-clock timeout, bounding CPU per image.
- Animated inputs are rejected rather than silently reduced to one frame.
- Storage keys are validated to be relative and traversal-free, and the local
  adapter additionally proves the resolved path stays inside its root.
- Nothing is written to storage until the image has been fully decoded and
  re-encoded, so unverified bytes are never published.
- EXIF, XMP and IPTC are stripped from derivatives, which removes GPS
  coordinates and camera identifiers from what is served publicly. The ICC
  colour profile is deliberately kept.

Credentials are read from server-side environment variables only. They are
never placed in a `NEXT_PUBLIC_` variable, never logged, and never included in
an error message.

### Out of scope

- The CDN and object-storage configuration themselves, which live outside this
  repository.
- Vulnerabilities in `libvips` or `sharp`. Report those upstream; we track
  advisories in CI with `npm audit` and update promptly.
