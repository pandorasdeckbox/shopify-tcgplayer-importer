import sanitizeHtml from 'sanitize-html';

const TCGPLAYER_HOSTS = new Set(['tcgplayer.com', 'www.tcgplayer.com']);
const PRODUCT_ID_PATTERN = /^[1-9][0-9]{0,19}$/;

export class TcgplayerInputError extends Error {
  statusCode = 400;

  constructor(message) {
    super(message);
    this.name = 'TcgplayerInputError';
  }
}

export class TcgplayerFetchError extends Error {
  statusCode = 502;

  constructor(message = 'Could not retrieve product details from TCGplayer') {
    super(message);
    this.name = 'TcgplayerFetchError';
  }
}

export function extractTcgplayerProductId(value) {
  let parsed;
  try {
    parsed = new URL(String(value || '').trim());
  } catch {
    throw new TcgplayerInputError('Enter a valid TCGplayer product URL');
  }

  if (
    parsed.protocol !== 'https:'
    || !TCGPLAYER_HOSTS.has(parsed.hostname.toLowerCase())
    || parsed.port
    || parsed.username
    || parsed.password
  ) {
    throw new TcgplayerInputError('Use an HTTPS URL from tcgplayer.com');
  }

  const match = parsed.pathname.match(/^\/product\/([1-9][0-9]{0,19})(?:\/|$)/);
  if (!match || !PRODUCT_ID_PATTERN.test(match[1])) {
    throw new TcgplayerInputError('The URL must point to a TCGplayer product');
  }
  return match[1];
}

function normalizedTitle(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function normalizeForComparison(value) {
  return normalizedTitle(value).toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function cleanTcgplayerTitle(value) {
  const title = normalizedTitle(value);
  const parts = title.split(/\s+-\s+/);
  if (parts.length < 3) return title;

  const retained = `${parts[0]} - ${parts[1]}`;
  const duplicateSuffix = parts.slice(2).join(' - ');
  const base = normalizeForComparison(parts[0]);
  return base.length >= 8 && normalizeForComparison(duplicateSuffix).includes(base)
    ? retained
    : title;
}

export function sanitizeDescriptionHtml(value) {
  const html = String(value || '').trim();
  if (html.length > 50_000) {
    throw new TcgplayerInputError('Description must be 50,000 characters or fewer');
  }
  return sanitizeHtml(html, {
    allowedTags: [
      'a', 'b', 'blockquote', 'br', 'em', 'h2', 'h3', 'h4', 'i',
      'li', 'ol', 'p', 'strong', 'u', 'ul',
    ],
    allowedAttributes: {
      a: ['href', 'title'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    disallowedTagsMode: 'discard',
  });
}

export function floorPriceToDollars(value) {
  const raw = String(value ?? '').trim().replace(/[$,\s]/g, '');
  const match = raw.match(/^([0-9]{1,9})(?:\.([0-9]{1,6}))?$/);
  if (!match) {
    throw new TcgplayerInputError('Enter a valid non-negative price');
  }
  const wholeDollars = Number(match[1]);
  if (!Number.isSafeInteger(wholeDollars) || wholeDollars <= 0) {
    throw new TcgplayerInputError('Price must be greater than zero');
  }
  return `${wholeDollars}.00`;
}

function getDescription(data) {
  const candidates = [
    data?.customAttributes?.description,
    data?.formattedAttributes?.Description,
    data?.description,
  ];
  return candidates.find(value => typeof value === 'string' && value.trim()) || '';
}

export async function fetchTcgplayerProduct({ url, fetchImpl = globalThis.fetch, timeoutMs = 12_000 }) {
  const productId = extractTcgplayerProductId(url);
  let response;
  try {
    response = await fetchImpl(`https://mp-search-api.tcgplayer.com/v2/product/${productId}/details`, {
      headers: {
        Accept: 'application/json, text/plain, */*',
        Origin: 'https://www.tcgplayer.com',
        Referer: 'https://www.tcgplayer.com/',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new TcgplayerFetchError('Could not connect to TCGplayer. Try again shortly.');
  }

  if (!response.ok) {
    throw new TcgplayerFetchError(`TCGplayer product lookup failed (${response.status})`);
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw new TcgplayerFetchError('TCGplayer returned an unreadable product response');
  }

  const returnedId = String(data?.productId ?? '');
  const title = cleanTcgplayerTitle(data?.productName || data?.name);
  const descriptionHtml = sanitizeDescriptionHtml(getDescription(data));
  const price = data?.marketPrice;
  if (
    returnedId !== productId
    || !title
    || !descriptionHtml
    || typeof price !== 'number'
    || !Number.isFinite(price)
    || price <= 0
  ) {
    throw new TcgplayerFetchError('TCGplayer did not return the required title, description, or Market Price');
  }

  return {
    sourceProductId: productId,
    sourceUrl: `https://www.tcgplayer.com/product/${productId}/`,
    imageUrl: `https://tcgplayer-cdn.tcgplayer.com/product/${productId}_in_1000x1000.jpg`,
    sku: productId,
    title,
    descriptionHtml,
    marketPrice: price,
    price: floorPriceToDollars(price),
  };
}

function normalizeOptionalMetadataText(value, label) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new TcgplayerInputError(`${label} must be text`);
  const normalized = value.trim();
  if (normalized.length > 255 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new TcgplayerInputError(`${label} must be 255 printable characters or fewer`);
  }
  return normalized;
}

function normalizeProductTags(value) {
  if (value === undefined || value === null || value === '') return [];
  const values = typeof value === 'string' ? value.split(',') : value;
  if (!Array.isArray(values)) throw new TcgplayerInputError('Tags must be a comma-separated list');
  if (values.length > 250) throw new TcgplayerInputError('A product can have at most 250 tags');

  const tags = [];
  const seen = new Set();
  for (const value of values) {
    if (typeof value !== 'string') throw new TcgplayerInputError('Tags must be text');
    const tag = value.trim();
    if (!tag) continue;
    if (tag.length > 255 || /[\u0000-\u001f\u007f]/.test(tag)) {
      throw new TcgplayerInputError('Tags must be 255 printable characters or fewer');
    }
    const key = tag.toLocaleLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      tags.push(tag);
    }
  }
  return tags;
}

export function normalizeDraftFields(fields) {
  const sourceProductId = extractTcgplayerProductId(fields?.sourceUrl);
  const title = normalizedTitle(fields?.title);
  const sku = String(fields?.sku ?? '').trim();
  const descriptionHtml = sanitizeDescriptionHtml(fields?.descriptionHtml);
  const price = floorPriceToDollars(fields?.price);
  const vendor = normalizeOptionalMetadataText(fields?.vendor, 'Vendor');
  const productType = normalizeOptionalMetadataText(fields?.productType, 'Product type');
  const categoryId = normalizeOptionalMetadataText(fields?.categoryId, 'Product category');
  const templateSuffix = normalizeOptionalMetadataText(fields?.templateSuffix, 'Theme template');
  const tags = normalizeProductTags(fields?.tags);

  if (!title || title.length > 255) {
    throw new TcgplayerInputError('Title must be between 1 and 255 characters');
  }
  if (
    categoryId
    && !/^gid:\/\/shopify\/TaxonomyCategory\/[A-Za-z0-9._-]+$/.test(categoryId)
  ) {
    throw new TcgplayerInputError('Choose a product category from the Shopify suggestions');
  }
  if (!sku || sku.length > 100 || /[\u0000-\u001f\u007f]/.test(sku)) {
    throw new TcgplayerInputError('SKU must be between 1 and 100 printable characters');
  }
  if (!descriptionHtml) {
    throw new TcgplayerInputError('Description cannot be empty');
  }

  return {
    sourceProductId,
    title,
    sku,
    descriptionHtml,
    price,
    vendor,
    categoryId,
    productType,
    templateSuffix,
    tags,
  };
}
