import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { SignJWT } from 'jose';
import { AppDatabase } from '../database.js';
import {
  AuthenticationError,
  createOAuthState,
  createShopifyAuth,
  hasRequiredScopes,
  sanitizeShop,
  verifyOAuthHmac,
  verifyShopifyIdToken,
} from '../auth.js';

const config = {
  shopifyApiKey: 'test-client-id',
  shopifyApiSecret: 'test-client-secret',
};

async function signedIdToken(shop = 'example-store.myshopify.com', overrides = {}) {
  const payload = {
    dest: `https://${shop}`,
    ...overrides,
  };
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(`https://${shop}/admin`)
    .setAudience(config.shopifyApiKey)
    .setIssuedAt()
    .setExpirationTime('2m')
    .sign(new TextEncoder().encode(config.shopifyApiSecret));
}

test('sanitizes Shopify shop domains and requires product and publication scopes', () => {
  assert.equal(sanitizeShop(' Example-Store.myshopify.com '), 'example-store.myshopify.com');
  assert.equal(sanitizeShop('https://example-store.myshopify.com'), null);
  assert.equal(sanitizeShop('evil.example.com'), null);
  assert.equal(hasRequiredScopes('read_products,write_products,read_publications,write_publications'), true);
  assert.equal(hasRequiredScopes('write_products,read_publications,write_publications'), false);
  assert.equal(hasRequiredScopes('read_products,write_products,write_publications'), false);
  assert.equal(hasRequiredScopes('write_products'), false);
});

test('creates URL-safe OAuth state and verifies Shopify callback HMAC', () => {
  const state = createOAuthState();
  assert.match(state, /^[A-Za-z0-9_-]+$/);

  const params = new URLSearchParams([
    ['code', 'one-time-code'],
    ['shop', 'example-store.myshopify.com'],
    ['state', state],
    ['timestamp', '1725000000'],
  ]);
  const message = [...params.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
  params.set('hmac', crypto.createHmac('sha256', config.shopifyApiSecret).update(message).digest('hex'));
  assert.equal(verifyOAuthHmac(params, config.shopifyApiSecret), true);
  params.set('state', 'changed');
  assert.equal(verifyOAuthHmac(params, config.shopifyApiSecret), false);
  params.append('shop', 'example-store.myshopify.com');
  assert.equal(verifyOAuthHmac(params, config.shopifyApiSecret), false);
});

test('validates Shopify ID token audience and shop claims', async () => {
  const token = await signedIdToken();
  assert.equal(await verifyShopifyIdToken(token, config), 'example-store.myshopify.com');

  const wrongShop = await signedIdToken('attacker.myshopify.com', {
    dest: 'https://example-store.myshopify.com',
  });
  await assert.rejects(verifyShopifyIdToken(wrongShop, config), AuthenticationError);
  await assert.rejects(verifyShopifyIdToken('invalid', config), AuthenticationError);
});

test('persists and consumes OAuth state once', async t => {
  const db = await new AppDatabase({ sqlitePath: ':memory:' }).init();
  t.after(() => db.close());

  const state = createOAuthState();
  await db.saveOAuthState('example-store.myshopify.com', state, Date.now() + 60_000);
  assert.equal(await db.consumeOAuthState('example-store.myshopify.com', state), true);
  assert.equal(await db.consumeOAuthState('example-store.myshopify.com', state), false);
});

test('refreshes expiring offline tokens and persists the rotated refresh token', async t => {
  const db = await new AppDatabase({ sqlitePath: ':memory:' }).init();
  t.after(() => db.close());
  const shop = 'example-store.myshopify.com';
  const now = Date.now();
  await db.storeShopifySession({
    shop,
    accessToken: 'expired-access-token',
    scope: 'read_products,write_products,read_publications,write_publications',
    expiresAt: now - 1,
    refreshToken: 'old-refresh-token',
    refreshTokenExpiresAt: now + 60 * 60 * 1000,
  });

  let requestBody;
  const auth = createShopifyAuth({
    db,
    config,
    fetchImpl: async (_url, options) => {
      requestBody = new URLSearchParams(options.body);
      return new Response(JSON.stringify({
        access_token: 'fresh-access-token',
        refresh_token: 'fresh-refresh-token',
        expires_in: 3600,
        refresh_token_expires_in: 7776000,
        scope: 'read_products,write_products,read_publications,write_publications',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });

  const session = await auth.getActiveSession(shop);
  assert.equal(requestBody.get('grant_type'), 'refresh_token');
  assert.equal(requestBody.get('refresh_token'), 'old-refresh-token');
  assert.equal(session.accessToken, 'fresh-access-token');
  assert.equal(session.refreshToken, 'fresh-refresh-token');
  assert.ok(session.expiresAt > now);
  assert.equal((await db.loadShopifySession(shop)).refreshToken, 'fresh-refresh-token');
});
