import crypto from 'node:crypto';
import { jwtVerify } from 'jose';

const REQUIRED_SCOPES = ['read_products', 'write_products', 'read_locations', 'read_inventory', 'write_inventory', 'read_publications', 'write_publications'];
const TOKEN_REFRESH_MARGIN_MS = 60_000;
const TOKEN_REQUEST_TIMEOUT_MS = 10_000;

export class AuthenticationError extends Error {
  statusCode = 401;

  constructor(message = 'Shopify authentication required') {
    super(message);
    this.name = 'AuthenticationError';
  }
}

export class ShopifyTokenError extends Error {
  statusCode = 502;

  constructor(message = 'Shopify token operation failed') {
    super(message);
    this.name = 'ShopifyTokenError';
  }
}

export function sanitizeShop(value) {
  const shop = String(value || '').trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop) ? shop : null;
}

export function createOAuthState() {
  return crypto.randomBytes(32).toString('base64url');
}

export function verifyOAuthHmac(params, secret) {
  if (!(params instanceof URLSearchParams) || !secret) return false;
  const entries = [...params.entries()];
  if (new Set(entries.map(([key]) => key)).size !== entries.length) return false;
  const supplied = params.get('hmac');
  if (!supplied || !/^[a-f0-9]{64}$/i.test(supplied)) return false;

  const message = entries
    .filter(([key]) => key !== 'hmac')
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
  const expected = crypto.createHmac('sha256', secret).update(message).digest();
  const actual = Buffer.from(supplied, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export function hasRequiredScopes(scope) {
  const granted = new Set(String(scope || '').split(',').map(value => value.trim()).filter(Boolean));
  return REQUIRED_SCOPES.every(required => granted.has(required));
}

export async function verifyShopifyIdToken(token, config, now = Date.now()) {
  if (!token || !config.shopifyApiSecret || !config.shopifyApiKey) {
    throw new AuthenticationError();
  }

  let payload;
  try {
    const result = await jwtVerify(token, new TextEncoder().encode(config.shopifyApiSecret), {
      algorithms: ['HS256'],
      audience: config.shopifyApiKey,
      currentDate: new Date(now),
    });
    payload = result.payload;
  } catch {
    throw new AuthenticationError('Shopify session token is invalid or expired');
  }

  let issuer;
  let destination;
  try {
    issuer = new URL(String(payload.iss || ''));
    destination = new URL(String(payload.dest || ''));
  } catch {
    throw new AuthenticationError('Shopify session token has invalid shop claims');
  }

  const shop = sanitizeShop(destination.hostname);
  if (
    !shop
    || issuer.protocol !== 'https:'
    || destination.protocol !== 'https:'
    || issuer.origin !== destination.origin
    || issuer.pathname !== '/admin'
    || destination.pathname !== '/'
    || issuer.search
    || issuer.hash
    || destination.search
    || destination.hash
  ) {
    throw new AuthenticationError('Shopify session token has invalid shop claims');
  }
  return shop;
}

function parseTokenResponse(payload, shop, priorScope = '') {
  const expiresIn = Number(payload?.expires_in);
  const refreshTokenExpiresIn = Number(payload?.refresh_token_expires_in);
  if (
    typeof payload?.access_token !== 'string'
    || !payload.access_token
    || typeof payload?.refresh_token !== 'string'
    || !payload.refresh_token
    || !Number.isFinite(expiresIn)
    || expiresIn <= 0
    || !Number.isFinite(refreshTokenExpiresIn)
    || refreshTokenExpiresIn <= 0
  ) {
    throw new ShopifyTokenError('Shopify did not return expiring offline access tokens');
  }
  const scope = typeof payload.scope === 'string' ? payload.scope : priorScope;
  if (!hasRequiredScopes(scope)) {
    throw new ShopifyTokenError('Shopify did not grant the required access scopes');
  }
  const now = Date.now();
  return {
    shop,
    accessToken: payload.access_token,
    scope,
    expiresAt: now + expiresIn * 1000,
    refreshToken: payload.refresh_token,
    refreshTokenExpiresAt: now + refreshTokenExpiresIn * 1000,
    updatedAt: now,
  };
}

export function createShopifyAuth({ db, config, fetchImpl = globalThis.fetch, now = Date.now }) {
  const refreshes = new Map();

  async function refreshSession(shop, current) {
    if (!current.refreshToken || current.refreshTokenExpiresAt <= now()) {
      await db.deleteShopifySession(shop);
      throw new AuthenticationError('Shopify access expired. Reinstall the app to reconnect.');
    }

    let response;
    try {
      response = await fetchImpl(`https://${shop}/admin/oauth/access_token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: config.shopifyApiKey,
          client_secret: config.shopifyApiSecret,
          refresh_token: current.refreshToken,
        }),
        signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new ShopifyTokenError('Could not reach Shopify to refresh the access token');
    }

    if (response.status === 401) {
      await db.deleteShopifySession(shop);
      throw new AuthenticationError('Shopify access was revoked. Reinstall the app to reconnect.');
    }
    if (response.status === 429 || response.status >= 500) {
      throw new ShopifyTokenError('Shopify is temporarily unavailable while refreshing access');
    }
    if (!response.ok) {
      throw new ShopifyTokenError(`Shopify rejected the access token refresh (${response.status})`);
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new ShopifyTokenError('Shopify returned an invalid token refresh response');
    }
    const renewed = parseTokenResponse(payload, shop, current.scope);
    const rotated = await db.rotateShopifySession(shop, current.refreshToken, renewed);
    if (rotated) return renewed;

    const latest = await db.loadShopifySession(shop);
    if (latest && latest.expiresAt > now() + TOKEN_REFRESH_MARGIN_MS) return latest;
    throw new ShopifyTokenError('Shopify access token changed concurrently; retry the request');
  }

  async function getActiveSession(shop) {
    const session = await db.loadShopifySession(shop);
    if (!session || !hasRequiredScopes(session.scope)) {
      throw new AuthenticationError();
    }
    if (session.expiresAt > now() + TOKEN_REFRESH_MARGIN_MS) return session;

    let refresh = refreshes.get(shop);
    if (!refresh) {
      refresh = refreshSession(shop, session);
      refreshes.set(shop, refresh);
    }
    try {
      return await refresh;
    } finally {
      if (refreshes.get(shop) === refresh) refreshes.delete(shop);
    }
  }

  async function requireShopifySession(req, res, next) {
    const authorization = req.get('authorization') || '';
    const match = authorization.match(/^Bearer\s+([^\s]+)$/i);
    if (!match) {
      res.set('X-Shopify-Retry-Invalid-Session-Request', '1');
      return res.status(401).json({ error: 'Shopify authentication required' });
    }

    try {
      const shop = await verifyShopifyIdToken(match[1], config, now());
      const session = await getActiveSession(shop);
      req.shop = shop;
      req.shopifySession = session;
      return next();
    } catch (error) {
      if (error instanceof AuthenticationError) {
        res.set('X-Shopify-Retry-Invalid-Session-Request', '1');
        return res.status(401).json({ error: error.message, needsReauth: true });
      }
      return next(error);
    }
  }

  return { getActiveSession, requireShopifySession };
}

export { REQUIRED_SCOPES, TOKEN_REFRESH_MARGIN_MS };
