import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config as defaultConfig } from './config.js';
import { AppDatabase } from './database.js';
import {
  AuthenticationError,
  createOAuthState,
  createShopifyAuth,
  hasRequiredScopes,
  sanitizeShop,
  ShopifyTokenError,
  verifyOAuthHmac,
} from './auth.js';
import { fetchTcgplayerProduct, normalizeDraftFields } from './tcgplayer.js';
import { normalizeProductImage } from './image.js';
import { ShopifyAdminClient } from './shopify-admin.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APP_SHELL = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const OAUTH_TIMESTAMP_TOLERANCE_SECONDS = 10 * 60;

function safeError(error) {
  return error instanceof Error ? error.message : 'Unexpected error';
}

function verifyWebhookHmac(rawBody, secret, supplied) {
  if (!Buffer.isBuffer(rawBody) || !secret || !supplied) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest();
  const actual = Buffer.from(supplied, 'base64');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function isFreshOAuthTimestamp(value) {
  const timestamp = Number(value);
  return Number.isInteger(timestamp)
    && Math.abs(Math.floor(Date.now() / 1000) - timestamp) <= OAUTH_TIMESTAMP_TOLERANCE_SECONDS;
}

function allowExtensionApiRequests(req, res, next) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  return next();
}

export function createApp({
  db,
  config = defaultConfig,
  fetchImpl = globalThis.fetch,
  shopifyClient,
  logger = console,
} = {}) {
  if (!db) throw new Error('createApp requires a database instance');
  const app = express();
  const auth = createShopifyAuth({ db, config, fetchImpl });
  const adminClient = shopifyClient || new ShopifyAdminClient({
    apiVersion: config.shopifyApiVersion,
    fetchImpl,
  });

  app.disable('x-powered-by');
  if (config.isProduction) app.set('trust proxy', 1);
  app.use(express.json({
    limit: '1mb',
    verify: (req, _res, buffer) => {
      req.rawBody = Buffer.from(buffer);
    },
  }));
  app.use(express.static(path.join(__dirname, 'public'), { index: false }));
  app.use('/api', allowExtensionApiRequests);

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  app.get('/auth', async (req, res, next) => {
    const shop = sanitizeShop(req.query.shop);
    if (!shop) return res.status(400).send('Missing or invalid shop');
    if (!config.shopifyApiKey || !config.shopifyApiSecret) {
      return res.status(503).send('Shopify authentication is not configured');
    }

    try {
      const state = createOAuthState();
      await db.saveOAuthState(shop, state, Date.now() + OAUTH_STATE_TTL_MS);
      const authorizationUrl = new URL(`https://${shop}/admin/oauth/authorize`);
      authorizationUrl.search = new URLSearchParams({
        client_id: config.shopifyApiKey,
        scope: 'write_products',
        redirect_uri: `${config.appUrl}/auth/callback`,
        state,
      }).toString();
      return res.redirect(authorizationUrl.toString());
    } catch (error) {
      return next(error);
    }
  });

  app.get('/auth/callback', async (req, res, next) => {
    try {
      const params = new URL(req.originalUrl, 'http://localhost').searchParams;
      if (!verifyOAuthHmac(params, config.shopifyApiSecret)) {
        return res.status(403).send('Invalid Shopify callback signature');
      }

      const shop = sanitizeShop(params.get('shop'));
      const code = params.get('code');
      const state = params.get('state');
      if (!shop || !code || !state) return res.status(400).send('Missing OAuth parameters');
      if (!isFreshOAuthTimestamp(params.get('timestamp'))) {
        return res.status(403).send('Shopify authorization expired; start installation again');
      }
      if (!await db.consumeOAuthState(shop, state)) {
        return res.status(403).send('Invalid or expired OAuth state');
      }

      let tokenResponse;
      try {
        tokenResponse = await fetchImpl(`https://${shop}/admin/oauth/access_token`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
          },
          body: new URLSearchParams({
            client_id: config.shopifyApiKey,
            client_secret: config.shopifyApiSecret,
            code,
            expiring: '1',
          }),
          signal: AbortSignal.timeout(10_000),
        });
      } catch {
        throw new ShopifyTokenError('Could not connect to Shopify to complete authorization');
      }
      if (!tokenResponse.ok) {
        throw new ShopifyTokenError(`Shopify token exchange failed (${tokenResponse.status})`);
      }

      let tokenData;
      try {
        tokenData = await tokenResponse.json();
      } catch {
        throw new ShopifyTokenError('Shopify returned an unreadable token response');
      }
      if (!hasRequiredScopes(tokenData.scope)) {
        return res.status(403).send('Shopify did not grant the required write_products scope');
      }

      const expiresIn = Number(tokenData.expires_in);
      const refreshTokenExpiresIn = Number(tokenData.refresh_token_expires_in);
      if (
        typeof tokenData.access_token !== 'string'
        || !tokenData.access_token
        || typeof tokenData.refresh_token !== 'string'
        || !tokenData.refresh_token
        || !Number.isFinite(expiresIn)
        || expiresIn <= 0
        || !Number.isFinite(refreshTokenExpiresIn)
        || refreshTokenExpiresIn <= 0
      ) {
        throw new ShopifyTokenError('Shopify did not return expiring offline access tokens');
      }

      const now = Date.now();
      await db.storeShopifySession({
        shop,
        accessToken: tokenData.access_token,
        scope: tokenData.scope,
        expiresAt: now + expiresIn * 1000,
        refreshToken: tokenData.refresh_token,
        refreshTokenExpiresAt: now + refreshTokenExpiresIn * 1000,
      });
      return res.redirect(`https://${shop}/admin/apps/${encodeURIComponent(config.shopifyApiKey)}`);
    } catch (error) {
      logger.error(`Shopify OAuth callback failed: ${safeError(error)}`);
      return next(error);
    }
  });

  app.get('/app', async (req, res, next) => {
    const shop = sanitizeShop(req.query.shop);
    if (!shop) return res.status(400).send('Missing or invalid shop');

    try {
      const session = await db.loadShopifySession(shop);
      if (!session || !hasRequiredScopes(session.scope)) {
        const authUrl = `${config.appUrl}/auth?shop=${encodeURIComponent(shop)}`;
        return res.type('html').send(
          `<!doctype html><html><body><script>window.top.location.href=${JSON.stringify(authUrl)};</script></body></html>`,
        );
      }
      return res.type('html').send(APP_SHELL.replaceAll('%SHOPIFY_API_KEY%', config.shopifyApiKey || ''));
    } catch (error) {
      return next(error);
    }
  });

  app.post('/api/import/preview', auth.requireShopifySession, async (req, res, next) => {
    try {
      const product = await fetchTcgplayerProduct({ url: req.body?.url, fetchImpl });
      const [image, catalogSuggestions] = await Promise.all([
        normalizeProductImage({
          productId: product.sourceProductId,
          fetchImpl,
        }),
        adminClient.getProductMetadataSuggestions({
          session: req.shopifySession,
          title: product.title,
          sku: product.sku,
          productLineName: product.productLineName,
          setName: product.setName,
        }),
      ]);
      return res.json({
        product: {
          ...product,
          vendor: catalogSuggestions.vendors[0]?.value || '',
          categoryId: catalogSuggestions.categories[0]?.id || '',
          productType: catalogSuggestions.productTypes[0]?.value || '',
          templateSuffix: catalogSuggestions.templates[0]?.value || '',
          tags: [],
          catalogSuggestions,
          imagePreviewDataUrl: `data:${image.mimeType};base64,${image.buffer.toString('base64')}`,
          imageDimensions: { width: image.width, height: image.height },
        },
      });
    } catch (error) {
      return next(error);
    }
  });

  app.post('/api/import/create', auth.requireShopifySession, async (req, res, next) => {
    try {
      const fields = normalizeDraftFields(req.body);
      const image = await normalizeProductImage({
        productId: fields.sourceProductId,
        fetchImpl,
      });
      const product = await adminClient.createDraftProduct({
        session: req.shopifySession,
        ...fields,
        image,
      });
      return res.status(201).json({ product });
    } catch (error) {
      return next(error);
    }
  });

  app.post('/webhooks/app/uninstalled', async (req, res, next) => {
    if (!verifyWebhookHmac(req.rawBody, config.shopifyApiSecret, req.get('x-shopify-hmac-sha256'))) {
      return res.status(401).send('Invalid webhook signature');
    }
    const shop = sanitizeShop(req.get('x-shopify-shop-domain'));
    if (!shop) return res.status(400).send('Missing or invalid shop domain');
    try {
      await db.deleteShopifySession(shop);
      return res.sendStatus(200);
    } catch (error) {
      return next(error);
    }
  });

  app.post('/webhooks/compliance', async (req, res, next) => {
    if (!verifyWebhookHmac(req.rawBody, config.shopifyApiSecret, req.get('x-shopify-hmac-sha256'))) {
      return res.status(401).send('Invalid webhook signature');
    }
    const topic = req.get('x-shopify-topic');
    if (!['customers/data_request', 'customers/redact', 'shop/redact'].includes(topic)) {
      return res.status(400).send('Unsupported compliance webhook topic');
    }
    if (topic === 'shop/redact') {
      const shop = sanitizeShop(req.get('x-shopify-shop-domain') || req.body?.shop_domain);
      if (!shop) return res.status(400).send('Missing or invalid shop domain');
      try {
        await db.deleteShopifySession(shop);
      } catch (error) {
        return next(error);
      }
    }
    return res.sendStatus(200);
  });

  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
    if (statusCode >= 500) {
      logger.error(`[${req.method} ${req.path}] ${safeError(error)}`);
    }
    if (error instanceof AuthenticationError) {
      return res.status(statusCode).json({ error: error.message, needsReauth: true });
    }
    return res.status(statusCode).json({
      error: statusCode >= 500 ? safeError(error) : error.message,
    });
  });

  return app;
}

export async function startServer() {
  const db = await new AppDatabase({
    databaseUrl: defaultConfig.databaseUrl,
    sqlitePath: defaultConfig.sqlitePath,
  }).init();
  const app = createApp({ db, config: defaultConfig });
  const server = app.listen(defaultConfig.port, () => {
    console.log(`TCGplayer Importer listening on port ${defaultConfig.port}`);
  });
  const shutdown = async () => {
    server.close(async () => {
      await db.close();
      process.exit(0);
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  startServer().catch(error => {
    console.error(`App startup failed: ${safeError(error)}`);
    process.exitCode = 1;
  });
}
