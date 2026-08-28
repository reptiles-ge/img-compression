# Rendering optimised images

```tsx
import { OptimizedImage, toImageAsset } from '@reptiles-ge/img-compression/next';

<OptimizedImage
  asset={toImageAsset(record)}
  alt="A blunt-nosed viper basking on limestone"
  sizes="(max-width: 768px) 100vw, 800px"
/>;
```

The component renders a `<picture>` offering AVIF first, WebP second, and the
preserved original as the `<img>` fallback for the small number of browsers
that support neither.

## Props

| Prop                       | Required | Notes                                                             |
| -------------------------- | -------- | ----------------------------------------------------------------- |
| `asset`                    | yes      | From `toImageAsset(record)`, or built from your own database row. |
| `alt`                      | yes      | Meaningful description, or `""` for a decorative image.           |
| `sizes`                    | yes      | How wide the image renders at each breakpoint.                    |
| `priority`                 | no       | Marks the LCP candidate. Defaults to `false`.                     |
| `className`, `style`, `id` | no       | Passed through to the `<img>`.                                    |

## Why `sizes` is required

With width descriptors in `srcSet`, a browser that is not told `sizes` assumes
`100vw` and picks the largest candidate on every device. That silently undoes
the reason several widths exist, and it is a mistake that is invisible in
review because the page still looks correct.

Making it a required prop turns a silent performance regression into a type
error.

Describe the rendered box, not the image:

```tsx
// Full width on mobile, half of a two-column grid above 768px, capped at 600px.
sizes = '(max-width: 768px) 100vw, (max-width: 1280px) 50vw, 600px';

// A fixed thumbnail.
sizes = '120px';

// Full-bleed hero.
sizes = '100vw';
```

## Hero images and LCP

Exactly one image per page should normally carry `priority`: the one the
Largest Contentful Paint measurement will land on. On a species page that is
the hero photograph.

With `priority`:

- `loading="eager"`, so it is not deferred
- `fetchpriority="high"`, so it outranks other requests
- `decoding="sync"`, so it is not painted late
- a `<link rel="preload" as="image">` carrying the AVIF `imagesrcset` and
  `imagesizes`, hoisted into the document head by React

The preload is typed `image/avif`, so a browser that cannot decode AVIF skips
it instead of downloading bytes it will not use.

Marking several images `priority` is worse than marking none: they compete for
bandwidth, and the one that actually matters arrives later than it would have.

## Lazy loading

Everything without `priority` gets `loading="lazy"` and `decoding="async"`,
which is right for species cards, galleries, article images and anything else
below the fold.

Do not apply `priority` to the first card in a grid out of habit. Check where
the fold actually falls on a phone; on most listing pages every card is below
it.

## Layout stability

The `<img>` always carries `width` and `height` from the largest derivative.
Browsers use that ratio to reserve the box before any bytes arrive, so images
contribute nothing to CLS.

This only works if your CSS preserves the ratio. When you constrain the width,
let the height follow:

```css
img {
  width: 100%;
  height: auto; /* without this, the reserved box is wrong */
}
```

For a fixed-ratio card, constrain the container instead and let the image fill
it:

```tsx
<div className="aspect-[3/2] overflow-hidden">
  <OptimizedImage
    asset={asset}
    alt="..."
    sizes="(max-width: 768px) 100vw, 33vw"
    className="w-full h-full object-cover"
  />
</div>
```

## Alt text

`alt` is required because an accessible name cannot be added later by anyone
who is not looking at the photograph.

Describe what is in the image and why it is on the page:

```tsx
alt = 'A blunt-nosed viper coiled on limestone, showing the zigzag dorsal pattern';
```

Not the file name, not a species name repeated for search engines, and not
`"image"`. Use `alt=""` only when the surrounding text already carries the
information and the image is purely decorative — an empty alt is a deliberate
statement, and it is better than a bad description.

## Building an asset without this package's record type

`ImageAsset` is a plain serialisable shape, so a database row maps onto it
directly:

```ts
const asset: ImageAsset = {
  width: row.width,
  height: row.height,
  sources: row.derivatives, // { format, url, width, height }
  fallbackUrl: row.originalUrl,
};
```

An asset with an empty `sources` array degrades to a plain `<img>` pointing at
the fallback, which is what you want for legacy images that have not been
processed yet.
