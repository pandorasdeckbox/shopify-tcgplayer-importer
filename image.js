import sharp from 'sharp';

const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
const MAX_SOURCE_PIXELS = 40_000_000;

export class ProductImageError extends Error {
  statusCode = 502;

  constructor(message = 'Could not prepare the TCGplayer product image') {
    super(message);
    this.name = 'ProductImageError';
  }
}

function productImageUrl(productId) {
  if (!/^[1-9][0-9]{0,19}$/.test(String(productId))) {
    throw new ProductImageError('The TCGplayer product ID is invalid');
  }
  return `https://tcgplayer-cdn.tcgplayer.com/product/${productId}_in_1000x1000.jpg`;
}

export async function normalizeProductImage({
  productId,
  fetchImpl = globalThis.fetch,
  timeoutMs = 12_000,
}) {
  const imageUrl = productImageUrl(productId);
  let response;
  try {
    response = await fetchImpl(imageUrl, {
      headers: { Accept: 'image/jpeg,image/png,image/webp' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new ProductImageError('Could not download the TCGplayer product image');
  }

  if (!response.ok) {
    throw new ProductImageError(`TCGplayer image download failed (${response.status})`);
  }
  const contentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(contentType)) {
    throw new ProductImageError('TCGplayer returned an unsupported image format');
  }

  let source;
  try {
    source = Buffer.from(await response.arrayBuffer());
  } catch {
    throw new ProductImageError('Could not read the TCGplayer product image');
  }
  if (!source.length || source.length > MAX_SOURCE_BYTES) {
    throw new ProductImageError('TCGplayer image must be no larger than 10 MB');
  }

  try {
    const resized = await sharp(source, { limitInputPixels: MAX_SOURCE_PIXELS })
      .rotate()
      .resize({ width: 880, height: 880, fit: 'inside' })
      .png()
      .toBuffer({ resolveWithObject: true });
    const left = Math.floor((1000 - resized.info.width) / 2);
    const top = Math.floor((1000 - resized.info.height) / 2);
    const buffer = await sharp({
      create: {
        width: 1000,
        height: 1000,
        channels: 3,
        background: { r: 255, g: 255, b: 255 },
      },
    })
      .composite([{ input: resized.data, left, top }])
      .jpeg({ quality: 92, mozjpeg: true })
      .toBuffer();

    return {
      buffer,
      filename: `tcgplayer-${productId}.jpg`,
      mimeType: 'image/jpeg',
      width: 1000,
      height: 1000,
      sourceUrl: imageUrl,
    };
  } catch {
    throw new ProductImageError('TCGplayer image could not be decoded or normalized');
  }
}
