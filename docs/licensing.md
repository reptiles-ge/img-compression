# Dependency licensing

This project is [MIT](../LICENSE) licensed and is distributed as an npm package
containing JavaScript and type declarations only.

## Runtime dependencies

| Package | Licence    | Compatible | Notes                                                                    |
| ------- | ---------- | ---------- | ------------------------------------------------------------------------ |
| `sharp` | Apache-2.0 | Yes        | Permissive; requires preserving its notice, which npm distribution does. |

`sharp` is the only runtime dependency. Everything else this package needs —
hashing, filesystem access, HTTP for Bunny — comes from the Node standard
library and the global `fetch`.

### libvips and its codecs

`sharp` installs prebuilt binaries through its `@img/sharp-*` platform packages.
Those binaries embed [libvips](https://github.com/libvips/libvips), which is
**LGPL-2.1-or-later**, along with codec libraries including libaom, libwebp,
libspng and libjpeg-turbo, which are BSD- or MIT-style.

LGPL-2.1 permits use by a differently licensed work when the library is
dynamically linked and replaceable. That condition holds here: the binaries are
separate `.node` and shared-library artefacts loaded at runtime, they are
neither modified nor statically linked into anything this project ships, and
`sharp` supports building against a system libvips instead. An MIT project may
therefore depend on it.

Two obligations follow, and both are met by normal npm distribution: the
licence notices travel with the installed packages, and a recipient can replace
the library. If this project ever vendored, patched or statically linked
libvips, that analysis would no longer hold and the licence position would need
revisiting.

## Peer dependencies

| Package | Licence | Notes                                                                |
| ------- | ------- | -------------------------------------------------------------------- |
| `react` | MIT     | Optional. Only needed for `@reptiles-ge/img-compression/next`.       |
| `next`  | MIT     | Optional. Listed for version alignment; nothing is imported from it. |

Both are optional peers, so a consumer using only the processing side installs
neither.

## Development dependencies

`typescript`, `vitest`, `eslint`, `typescript-eslint`, `@eslint/js`,
`prettier`, `tsx`, `react`, `react-dom` and the corresponding `@types`
packages. All MIT or Apache-2.0, none present in the published artefact, and
none reachable by a consumer at runtime.

## Adding a dependency

Check the licence before proposing it. Permissive licences (MIT, ISC, BSD,
Apache-2.0) are fine. A copyleft runtime dependency that is statically linked
or otherwise not separable is not compatible with distributing this under MIT.

If the position is unclear, say so in the pull request rather than assuming it
is fine. Documenting an uncertainty is cheap; discovering a licence conflict
after a release is not.
