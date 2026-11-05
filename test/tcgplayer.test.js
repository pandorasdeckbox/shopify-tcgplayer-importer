import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanTcgplayerTitle,
  extractTcgplayerProductId,
  fetchTcgplayerProduct,
  floorPriceToDollars,
  normalizeDraftFields,
  sanitizeDescriptionHtml,
  TcgplayerInputError,
  TcgplayerFetchError,
} from '../tcgplayer.js';

const sampleProduct = {
  productId: 711385,
  productName: 'Extra Booster: One Piece Heroines Edition Vol.2 - Booster Box',
  productLineName: 'One Piece Card Game',
  setName: 'Heroines Edition Vol.2',
  marketPrice: 266.73,
  customAttributes: {
    description: 'Product Details<br><br>The second Extra Booster.<br><strong>Set Breakdown</strong>',
  },
};

test('extracts product IDs only from HTTPS TCGplayer product URLs', () => {
  assert.equal(extractTcgplayerProductId('https://www.tcgplayer.com/product/711385/'), '711385');
  assert.equal(extractTcgplayerProductId('https://tcgplayer.com/product/123456/card-name'), '123456');
  assert.throws(() => extractTcgplayerProductId('http://www.tcgplayer.com/product/711385/'), TcgplayerInputError);
  assert.throws(() => extractTcgplayerProductId('https://www.tcgplayer.com.evil.example/product/711385/'), TcgplayerInputError);
  assert.throws(() => extractTcgplayerProductId('https://www.tcgplayer.com/search/product/711385'), TcgplayerInputError);
});

test('removes only a clearly duplicated trailing title segment', () => {
  assert.equal(
    cleanTcgplayerTitle('Extra Booster: One Piece Heroines Edition Vol.2 - Booster Box - Extra Booster: One Piece Heroines Edition Vol. 2 (EB05)'),
    'Extra Booster: One Piece Heroines Edition Vol.2 - Booster Box',
  );
  assert.equal(cleanTcgplayerTitle('One Piece - Starter Deck'), 'One Piece - Starter Deck');
  assert.equal(cleanTcgplayerTitle('Sword - Art - Online'), 'Sword - Art - Online');
});

test('floors TCGplayer market prices to whole dollar values', () => {
  assert.equal(floorPriceToDollars(266.73), '266.00');
  assert.equal(floorPriceToDollars(267.1132), '267.00');
  assert.equal(floorPriceToDollars('$1,266.73'), '1266.00');
  assert.throws(() => floorPriceToDollars('0'), TcgplayerInputError);
  assert.throws(() => floorPriceToDollars('-1.00'), TcgplayerInputError);
  assert.throws(() => floorPriceToDollars('not a price'), TcgplayerInputError);
});

test('sanitizes unsafe description HTML while preserving useful formatting', () => {
  const html = sanitizeDescriptionHtml('<p onclick="alert(1)">Details<br><strong>Set breakdown</strong><script>alert(2)</script><a href="javascript:alert(3)">bad</a></p>');
  assert.match(html, /<p>/);
  assert.match(html, /<br/);
  assert.match(html, /<strong>Set breakdown<\/strong>/);
  assert.doesNotMatch(html, /onclick|script|javascript:/i);
});

test('fetches current TCGplayer details and returns editable product fields', async () => {
  let requestedUrl;
  let requestedHeaders;
  const product = await fetchTcgplayerProduct({
    url: 'https://www.tcgplayer.com/product/711385/',
    fetchImpl: async (url, options) => {
      requestedUrl = url;
      requestedHeaders = options.headers;
      return new Response(JSON.stringify(sampleProduct), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  assert.match(requestedUrl, /mp-search-api\.tcgplayer\.com\/v2\/product\/711385\/details/);
  assert.equal(requestedHeaders.Origin, 'https://www.tcgplayer.com');
  assert.equal(product.sourceProductId, '711385');
  assert.equal(product.sku, '711385');
  assert.equal(product.title, sampleProduct.productName);
  assert.equal(product.productLineName, sampleProduct.productLineName);
  assert.equal(product.setName, sampleProduct.setName);
  assert.equal(product.price, '266.00');
  assert.match(product.descriptionHtml, /<strong>Set Breakdown<\/strong>/);
  assert.equal(product.imageUrl, 'https://tcgplayer-cdn.tcgplayer.com/product/711385_in_1000x1000.jpg');
});

test('reports source errors instead of returning incomplete product data', async () => {
  await assert.rejects(
    fetchTcgplayerProduct({
      url: 'https://www.tcgplayer.com/product/711385/',
      fetchImpl: async () => new Response('blocked', { status: 403 }),
    }),
    TcgplayerFetchError,
  );
  await assert.rejects(
    fetchTcgplayerProduct({
      url: 'https://www.tcgplayer.com/product/711385/',
      fetchImpl: async () => new Response(JSON.stringify({ ...sampleProduct, marketPrice: null }), { status: 200 }),
    }),
    TcgplayerFetchError,
  );
});

test('normalizes and validates fields again before product creation', () => {
  const fields = normalizeDraftFields({
    sourceUrl: 'https://www.tcgplayer.com/product/711385/',
    title: 'Edited title',
    sku: '711385',
    price: '266.73',
    descriptionHtml: '<p>Description</p><script>unsafe()</script>',
    vendor: ' Bandai ',
    categoryId: 'gid://shopify/TaxonomyCategory/aa-1-2',
    productType: ' Trading Card Game ',
    templateSuffix: ' card-game ',
    tags: 'One Piece, Booster Box, one piece',
    publicationIds: ['gid://shopify/Publication/101', 'gid://shopify/Publication/101'],
  });
  assert.equal(fields.title, 'Edited title');
  assert.equal(fields.sku, '711385');
  assert.equal(fields.price, '266.00');
  assert.equal(fields.descriptionHtml, '<p>Description</p>');
  assert.equal(fields.sourceProductId, '711385');
  assert.equal(fields.vendor, 'Bandai');
  assert.equal(fields.categoryId, 'gid://shopify/TaxonomyCategory/aa-1-2');
  assert.equal(fields.productType, 'Trading Card Game');
  assert.equal(fields.templateSuffix, 'card-game');
  assert.deepEqual(fields.tags, ['One Piece', 'Booster Box']);
  assert.deepEqual(fields.publicationIds, ['gid://shopify/Publication/101']);
  assert.throws(() => normalizeDraftFields({
    sourceUrl: 'https://www.tcgplayer.com/product/711385/',
    title: 'Edited title',
    sku: '711385',
    price: '266.00',
    descriptionHtml: '<script>unsafe()</script>',
  }), TcgplayerInputError);
  assert.throws(() => normalizeDraftFields({
    sourceUrl: 'https://www.tcgplayer.com/product/711385/',
    title: 'Edited title',
    sku: '711385',
    price: '266.00',
    descriptionHtml: '<p>Description</p>',
    categoryId: 'gid://shopify/Product/9001',
  }), TcgplayerInputError);
  assert.throws(() => normalizeDraftFields({
    sourceUrl: 'https://www.tcgplayer.com/product/711385/',
    title: 'Edited title',
    sku: '711385',
    price: '266.00',
    descriptionHtml: '<p>Description</p>',
    tags: 42,
  }), TcgplayerInputError);
  assert.throws(() => normalizeDraftFields({
    sourceUrl: 'https://www.tcgplayer.com/product/711385/',
    title: 'Edited title',
    sku: '711385',
    price: '266.00',
    descriptionHtml: '<p>Description</p>',
    publicationIds: ['gid://shopify/Product/9001'],
  }), TcgplayerInputError);
});
