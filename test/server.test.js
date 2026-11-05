import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { SignJWT } from 'jose';
import sharp from 'sharp';
import { AppDatabase } from '../database.js';
import { createApp } from '../server.js';

const shop = 'example-store.myshopify.com';
const apiKey = 'test-client-id';
const apiSecret = 'test-client-secret';
const scopes = 'read_products,write_products,read_locations,read_inventory,write_inventory,read_publications,write_publications';
const grantedWriteScopes = 'write_products,read_locations,write_inventory,write_publications';

async function createIdToken() {
  return new SignJWT({ dest: `https://${shop}` })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(`https://${shop}/admin`)
    .setAudience(apiKey)
    .setIssuedAt()
    .setExpirationTime('2m')
    .sign(new TextEncoder().encode(apiSecret));
}

async function withRunningApp(t, app) {
  const server = app.listen(0);
  await once(server, 'listening');
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test('exchanges the OAuth code for expiring offline tokens', async t => {
  const db = await new AppDatabase({ sqlitePath: ':memory:' }).init();
  t.after(() => db.close());
  let tokenRequest;
  const app = createApp({
    db,
    config: {
      shopifyApiKey: apiKey,
      shopifyApiSecret: apiSecret,
      appUrl: 'https://importer.example.com',
      isProduction: false,
    },
    fetchImpl: async (url, options) => {
      tokenRequest = { url, ...options };
      return new Response(JSON.stringify({
        access_token: 'offline-access-token',
        refresh_token: 'offline-refresh-token',
        scope: grantedWriteScopes,
        expires_in: 3600,
        refresh_token_expires_in: 7776000,
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
    logger: { error() {} },
  });
  const baseUrl = await withRunningApp(t, app);
  const authorizationResponse = await fetch(`${baseUrl}/auth?shop=${shop}`, {
    redirect: 'manual',
  });
  assert.equal(authorizationResponse.status, 302);
  const authorizationUrl = new URL(authorizationResponse.headers.get('location'));
  const state = authorizationUrl.searchParams.get('state');
  assert.equal(authorizationUrl.searchParams.get('scope'), scopes);
  assert.equal(authorizationUrl.searchParams.has('expiring'), false);

  const params = new URLSearchParams({
    code: 'authorization-code',
    shop,
    state,
    timestamp: String(Math.floor(Date.now() / 1000)),
  });
  const message = [...params.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
  params.set('hmac', crypto.createHmac('sha256', apiSecret).update(message).digest('hex'));
  const callbackResponse = await fetch(`${baseUrl}/auth/callback?${params}`, {
    redirect: 'manual',
  });

  assert.equal(callbackResponse.status, 302);
  assert.equal(callbackResponse.headers.get('location'), `https://${shop}/admin/apps/${apiKey}`);
  assert.equal(tokenRequest.url, `https://${shop}/admin/oauth/access_token`);
  assert.equal(tokenRequest.headers.Accept, 'application/json');
  assert.equal(tokenRequest.body.get('code'), 'authorization-code');
  assert.equal(tokenRequest.body.get('expiring'), '1');
  const session = await db.loadShopifySession(shop);
  assert.equal(session.accessToken, 'offline-access-token');
  assert.equal(session.refreshToken, 'offline-refresh-token');
  assert.equal(session.scope, grantedWriteScopes);
});

test('reports the exact scopes missing from Shopify OAuth grant', async t => {
  const db = await new AppDatabase({ sqlitePath: ':memory:' }).init();
  t.after(() => db.close());
  const grantedScopes = scopes.split(',').filter(scope => scope !== 'write_publications').join(',');
  const app = createApp({
    db,
    config: {
      shopifyApiKey: apiKey,
      shopifyApiSecret: apiSecret,
      appUrl: 'https://importer.example.com',
      isProduction: false,
    },
    fetchImpl: async () => new Response(JSON.stringify({
      access_token: 'offline-access-token',
      refresh_token: 'offline-refresh-token',
      scope: grantedScopes,
      expires_in: 3600,
      refresh_token_expires_in: 7776000,
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
    logger: { error() {} },
  });
  const baseUrl = await withRunningApp(t, app);
  const authorizationResponse = await fetch(`${baseUrl}/auth?shop=${shop}`, {
    redirect: 'manual',
  });
  const authorizationUrl = new URL(authorizationResponse.headers.get('location'));
  const params = new URLSearchParams({
    code: 'authorization-code',
    shop,
    state: authorizationUrl.searchParams.get('state'),
    timestamp: String(Math.floor(Date.now() / 1000)),
  });
  const message = [...params.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
  params.set('hmac', crypto.createHmac('sha256', apiSecret).update(message).digest('hex'));

  const callbackResponse = await fetch(`${baseUrl}/auth/callback?${params}`, {
    redirect: 'manual',
  });

  assert.equal(callbackResponse.status, 403);
  assert.match(await callbackResponse.text(), /Missing: write_publications/);
  assert.equal(await db.loadShopifySession(shop), null);
});

test('uses App Bridge to start OAuth from an unauthenticated embedded app load', async t => {
  const db = await new AppDatabase({ sqlitePath: ':memory:' }).init();
  t.after(() => db.close());
  const app = createApp({
    db,
    config: {
      shopifyApiKey: apiKey,
      shopifyApiSecret: apiSecret,
      shopifyApiVersion: '2026-10',
      appUrl: 'https://importer.example.com',
      isProduction: false,
    },
    fetchImpl: async () => {
      throw new Error('No external request expected');
    },
    logger: { error() {} },
  });
  const baseUrl = await withRunningApp(t, app);

  const response = await fetch(`${baseUrl}/app?shop=${shop}&host=embedded-host`);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<meta name="shopify-api-key" content="test-client-id">/);
  assert.match(html, /https:\/\/cdn\.shopify\.com\/shopifycloud\/app-bridge\.js/);
  assert.match(
    html,
    /window\.open\("https:\/\/importer\.example\.com\/auth\?shop=example-store\.myshopify\.com", '_top'\)/,
  );
  assert.doesNotMatch(html, /window\.top\.location\.href/);
});

test('serves the embedded importer and authenticates preview/create requests', async t => {
  const db = await new AppDatabase({ sqlitePath: ':memory:' }).init();
  t.after(() => db.close());
  await db.storeShopifySession({
    shop,
    accessToken: 'offline-access-token',
    scope: scopes,
    expiresAt: Date.now() + 60 * 60 * 1000,
    refreshToken: 'refresh-token',
    refreshTokenExpiresAt: Date.now() + 90 * 24 * 60 * 60 * 1000,
  });

  const imageBytes = await sharp({
    create: {
      width: 1000,
      height: 1000,
      channels: 3,
      background: { r: 240, g: 220, b: 180 },
    },
  }).jpeg().toBuffer();
  const sourceData = {
    productId: 711385,
    productName: 'Extra Booster: One Piece Heroines Edition Vol.2 - Booster Box',
    productLineName: 'One Piece Card Game',
    setName: 'Heroines Edition Vol.2',
    marketPrice: 266.73,
    customAttributes: {
      description: 'Product Details<br><strong>Set Breakdown</strong>',
    },
  };
  const remoteFetch = async url => {
    if (String(url).includes('mp-search-api.tcgplayer.com')) {
      return new Response(JSON.stringify(sourceData), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (String(url).includes('tcgplayer-cdn.tcgplayer.com')) {
      return new Response(imageBytes, {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      });
    }
    throw new Error(`Unexpected remote request ${url}`);
  };
  let created;
  const app = createApp({
    db,
    config: {
      shopifyApiKey: apiKey,
      shopifyApiSecret: apiSecret,
      shopifyApiVersion: '2026-10',
      appUrl: 'https://importer.example.com',
      isProduction: false,
    },
    fetchImpl: remoteFetch,
    shopifyClient: {
      getProductMetadataSuggestions: async ({ title, sku, productLineName, setName }) => {
        assert.equal(title, sourceData.productName);
        assert.equal(sku, '711385');
        assert.equal(productLineName, sourceData.productLineName);
        assert.equal(setName, sourceData.setName);
        return {
          similarProductCount: 2,
          similarProducts: [{ title: 'One Piece Starter Deck', vendor: 'Bandai' }],
          vendors: [{ value: 'Bandai', count: 2 }],
          categories: [{
            id: 'gid://shopify/TaxonomyCategory/aa-1-2',
            name: 'Trading Cards',
            fullName: 'Toys & Games > Games > Trading Cards',
            count: 2,
          }],
          productTypes: [{ value: 'Trading Card Game', count: 2 }],
          templates: [{ value: '', label: 'Default product', count: 2 }],
          tags: [{ value: 'One Piece', count: 2 }],
          publications: [{
            id: 'gid://shopify/Publication/100',
            name: 'Online Store',
            count: 2,
            suggested: true,
          }],
        };
      },
      createDraftProduct: async input => {
        created = input;
        return {
          id: 'gid://shopify/Product/9001',
          numericId: '9001',
          title: input.title,
          status: 'DRAFT',
          sku: input.sku,
          price: input.price,
          adminUrl: `https://${shop}/admin/products/9001`,
        };
      },
    },
    logger: { error() {} },
  });
  const baseUrl = await withRunningApp(t, app);
  const idToken = await createIdToken();

  const appHomeResponse = await fetch(`${baseUrl}/app?shop=${shop}`);
  assert.equal(appHomeResponse.status, 200);
  const appHome = await appHomeResponse.text();
  assert.match(appHome, /id="lookup-form"/);
  assert.match(appHome, /id="product-vendor"/);
  assert.match(appHome, /id="product-cost"/);
  assert.match(appHome, /id="product-barcode"/);
  assert.match(appHome, /id="product-category"/);
  assert.match(appHome, /id="product-type"/);
  assert.match(appHome, /id="product-template"/);
  assert.match(appHome, /src="\/app\.js"/);

  const appScriptResponse = await fetch(`${baseUrl}/app.js`);
  assert.equal(appScriptResponse.status, 200);
  const appScript = await appScriptResponse.text();
  assert.match(appScript, /\/api\/import\/preview/);
  assert.match(appScript, /\/api\/import\/create/);
  assert.match(appScript, /cost: costInput\.value/);
  assert.match(appScript, /barcode: barcodeInput\.value/);

  const unauthenticated = await fetch(`${baseUrl}/api/import/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://www.tcgplayer.com/product/711385/' }),
  });
  assert.equal(unauthenticated.status, 401);

  const previewResponse = await fetch(`${baseUrl}/api/import/preview`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${idToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ url: 'https://www.tcgplayer.com/product/711385/' }),
  });
  assert.equal(previewResponse.status, 200);
  const preview = (await previewResponse.json()).product;
  assert.equal(preview.sku, '711385');
  assert.equal(preview.price, '266.00');
  assert.equal(preview.cost, '');
  assert.equal(preview.barcode, '');
  assert.equal(preview.vendor, 'Bandai');
  assert.equal(preview.categoryId, 'gid://shopify/TaxonomyCategory/aa-1-2');
  assert.equal(preview.productType, 'Trading Card Game');
  assert.equal(preview.templateSuffix, '');
  assert.deepEqual(preview.tags, []);
  assert.equal(preview.catalogSuggestions.similarProductCount, 2);
  assert.deepEqual(preview.publicationIds, ['gid://shopify/Publication/100']);
  assert.match(preview.imagePreviewDataUrl, /^data:image\/jpeg;base64,/);
  assert.deepEqual(preview.imageDimensions, { width: 1000, height: 1000 });

  const createResponse = await fetch(`${baseUrl}/api/import/create`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${idToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      sourceUrl: preview.sourceUrl,
      title: 'Edited title',
      sku: '711385',
      price: '266.73',
      cost: '12.50',
      barcode: '0001234567890',
      descriptionHtml: '<p>Edited description</p><script>unsafe()</script>',
      vendor: 'Bandai',
      categoryId: 'gid://shopify/TaxonomyCategory/aa-1-2',
      productType: 'Trading Card Game',
      templateSuffix: 'card-game',
      tags: 'One Piece, Booster Box',
      publicationIds: preview.publicationIds,
    }),
  });
  assert.equal(createResponse.status, 201);
  const result = await createResponse.json();
  assert.equal(result.product.status, 'DRAFT');
  assert.equal(created.title, 'Edited title');
  assert.equal(created.sku, '711385');
  assert.equal(created.price, '266.00');
  assert.equal(created.cost, '12.50');
  assert.equal(created.barcode, '0001234567890');
  assert.equal(created.descriptionHtml, '<p>Edited description</p>');
  assert.equal(created.vendor, 'Bandai');
  assert.equal(created.categoryId, 'gid://shopify/TaxonomyCategory/aa-1-2');
  assert.equal(created.productType, 'Trading Card Game');
  assert.equal(created.templateSuffix, 'card-game');
  assert.deepEqual(created.tags, ['One Piece', 'Booster Box']);
  assert.deepEqual(created.publicationIds, ['gid://shopify/Publication/100']);
  assert.deepEqual(await sharp(created.image.buffer).metadata().then(({ width, height }) => ({ width, height })), {
    width: 1000,
    height: 1000,
  });
});

test('verifies Shopify webhooks and removes shop credentials on uninstall', async t => {
  const db = await new AppDatabase({ sqlitePath: ':memory:' }).init();
  t.after(() => db.close());
  await db.storeShopifySession({
    shop,
    accessToken: 'offline-access-token',
    scope: scopes,
    expiresAt: Date.now() + 60 * 60 * 1000,
    refreshToken: 'refresh-token',
    refreshTokenExpiresAt: Date.now() + 90 * 24 * 60 * 60 * 1000,
  });
  const app = createApp({
    db,
    config: { shopifyApiKey: apiKey, shopifyApiSecret: apiSecret, appUrl: 'https://app.example.com' },
    fetchImpl: async () => {
      throw new Error('No external request expected');
    },
    logger: { error() {} },
  });
  const baseUrl = await withRunningApp(t, app);
  const body = Buffer.from('{}');
  const signature = crypto.createHmac('sha256', apiSecret).update(body).digest('base64');

  const response = await fetch(`${baseUrl}/app/webhooks/app/uninstalled`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Hmac-Sha256': signature,
      'X-Shopify-Shop-Domain': shop,
    },
    body,
  });
  assert.equal(response.status, 200);
  assert.equal(await db.loadShopifySession(shop), null);

  const wrongSignature = crypto.createHmac('sha256', 'incorrect-secret').update(body).digest('base64');
  const invalid = await fetch(`${baseUrl}/app/webhooks/compliance`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Hmac-Sha256': wrongSignature,
      'X-Shopify-Topic': 'customers/data_request',
    },
    body,
  });
  assert.equal(invalid.status, 401);

  const validSignature = crypto.createHmac('sha256', apiSecret).update(body).digest('base64');
  const valid = await fetch(`${baseUrl}/app/webhooks/compliance`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Hmac-Sha256': validSignature,
      'X-Shopify-Topic': 'customers/data_request',
    },
    body,
  });
  assert.equal(valid.status, 200);
});
