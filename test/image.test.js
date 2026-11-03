import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { normalizeProductImage, ProductImageError } from '../image.js';

test('creates a 1000x1000 white-canvas JPEG with artwork contained in 880x880', async () => {
  const source = await sharp({
    create: {
      width: 1000,
      height: 1000,
      channels: 3,
      background: { r: 210, g: 25, b: 35 },
    },
  }).jpeg().toBuffer();

  let requestedUrl;
  const image = await normalizeProductImage({
    productId: '711385',
    fetchImpl: async url => {
      requestedUrl = url;
      return new Response(source, {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      });
    },
  });

  assert.equal(requestedUrl, 'https://tcgplayer-cdn.tcgplayer.com/product/711385_in_1000x1000.jpg');
  assert.equal(image.width, 1000);
  assert.equal(image.height, 1000);
  assert.equal(image.mimeType, 'image/jpeg');
  assert.equal(image.filename, 'tcgplayer-711385.jpg');

  const { data, info } = await sharp(image.buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.width, 1000);
  assert.equal(info.height, 1000);
  const pixel = (x, y) => {
    const index = (y * info.width + x) * info.channels;
    return [...data.subarray(index, index + 3)];
  };
  assert.ok(pixel(5, 5).every(value => value > 245));
  assert.ok(pixel(50, 500).every(value => value > 245));
  assert.ok(pixel(500, 500)[0] > 170);
  assert.ok(pixel(60, 500)[0] < 250);
});

test('rejects invalid IDs, failed downloads, and unsupported image content types', async () => {
  await assert.rejects(normalizeProductImage({ productId: 'https://example.com' }), ProductImageError);
  await assert.rejects(
    normalizeProductImage({
      productId: '711385',
      fetchImpl: async () => new Response('blocked', { status: 403 }),
    }),
    ProductImageError,
  );
  await assert.rejects(
    normalizeProductImage({
      productId: '711385',
      fetchImpl: async () => new Response('not image', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    }),
    ProductImageError,
  );
});
