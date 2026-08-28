import sharp from 'sharp';

/**
 * Structural similarity, implemented here rather than pulled in as a package.
 *
 * It is roughly sixty lines against a well-known formula, it is only ever used
 * by the benchmark script, and it never ships to production. Adding a runtime
 * dependency to a package that already carries a native binary, purely to
 * produce a number for a report, is not a trade worth making.
 *
 * Follows Wang et al. (2004): an 8x8 sliding window over the luma plane with
 * the standard stabilising constants.
 */

const WINDOW = 8;
const C1 = (0.01 * 255) ** 2;
const C2 = (0.03 * 255) ** 2;

interface Luma {
  readonly data: Buffer;
  readonly width: number;
  readonly height: number;
}

async function toLuma(image: Buffer): Promise<Luma> {
  const { data, info } = await sharp(image)
    .greyscale()
    .raw({ depth: 'uchar' })
    .toBuffer({ resolveWithObject: true });

  return { data, width: info.width, height: info.height };
}

/**
 * Mean SSIM between two images, in the range 0 to 1, where 1 is identical.
 * Both images must already share the same dimensions.
 */
export async function meanSsim(reference: Buffer, candidate: Buffer): Promise<number> {
  const [a, b] = await Promise.all([toLuma(reference), toLuma(candidate)]);

  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(
      `SSIM needs matching dimensions, received ${a.width}x${a.height} and ${b.width}x${b.height}.`,
    );
  }

  let total = 0;
  let windows = 0;

  for (let top = 0; top + WINDOW <= a.height; top += WINDOW) {
    for (let left = 0; left + WINDOW <= a.width; left += WINDOW) {
      total += windowSsim(a, b, left, top);
      windows += 1;
    }
  }

  return windows === 0 ? 1 : total / windows;
}

function windowSsim(a: Luma, b: Luma, left: number, top: number): number {
  const count = WINDOW * WINDOW;
  let sumA = 0;
  let sumB = 0;

  for (let y = 0; y < WINDOW; y += 1) {
    const row = (top + y) * a.width + left;
    for (let x = 0; x < WINDOW; x += 1) {
      sumA += a.data[row + x] as number;
      sumB += b.data[row + x] as number;
    }
  }

  const meanA = sumA / count;
  const meanB = sumB / count;

  let varianceA = 0;
  let varianceB = 0;
  let covariance = 0;

  for (let y = 0; y < WINDOW; y += 1) {
    const row = (top + y) * a.width + left;
    for (let x = 0; x < WINDOW; x += 1) {
      const deltaA = (a.data[row + x] as number) - meanA;
      const deltaB = (b.data[row + x] as number) - meanB;
      varianceA += deltaA * deltaA;
      varianceB += deltaB * deltaB;
      covariance += deltaA * deltaB;
    }
  }

  // Sample variance, matching the reference implementation.
  const divisor = count - 1;
  varianceA /= divisor;
  varianceB /= divisor;
  covariance /= divisor;

  const numerator = (2 * meanA * meanB + C1) * (2 * covariance + C2);
  const denominator = (meanA ** 2 + meanB ** 2 + C1) * (varianceA + varianceB + C2);

  return numerator / denominator;
}
