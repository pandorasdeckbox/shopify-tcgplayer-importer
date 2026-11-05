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
    productLineName: typeof data?.productLineName === 'string' ? normalizedTitle(data.productLineName) : '',
    setName: typeof data?.setName === 'string' ? normalizedTitle(data.setName) : '',
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

function hasValidGtinCheckDigit(value) {
  if (!/^(?:\d{8}|\d{12}|\d{13}|\d{14})$/.test(value)) return false;
  let sum = 0;
  let weight = 3;
  for (let index = value.length - 2; index >= 0; index -= 1) {
    sum += Number(value[index]) * weight;
    weight = weight === 3 ? 1 : 3;
  }
  return (10 - (sum % 10)) % 10 === Number(value.at(-1));
}

function isValidIsbn10(value) {
  if (!/^\d{9}[\dX]$/i.test(value)) return false;
  const checksum = [...value.toUpperCase()].reduce(
    (sum, character, index) => sum + (character === 'X' ? 10 : Number(character)) * (10 - index),
    0,
  );
  return checksum % 11 === 0;
}

export function detectBarcodeType(value) {
  if (typeof value !== 'string') return null;
  if (isValidIsbn10(value)) return 'ISBN';
  if (/^(?:978|979)\d{10}$/.test(value) && hasValidGtinCheckDigit(value)) return 'ISBN';
  if (hasValidGtinCheckDigit(value)) return 'GTIN';
  return null;
}

function normalizeOptionalCost(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new TcgplayerInputError('Cost per item must be text');
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new TcgplayerInputError('Cost per item must be a non-negative amount');
  }

  const raw = value.trim().replace(/[$,\s]/g, '');
  if (!raw) return '';
  const match = raw.match(/^([0-9]{1,9})(?:\.([0-9]{0,2}))?$/);
  if (!match) {
    throw new TcgplayerInputError('Cost per item must be a non-negative amount with up to 2 decimal places');
  }
  const wholeDollars = Number(match[1]);
  if (!Number.isSafeInteger(wholeDollars)) {
    throw new TcgplayerInputError('Cost per item is outside the supported range');
  }
  return `${wholeDollars}.${(match[2] || '').padEnd(2, '0')}`;
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

function normalizePublicationIds(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 20) {
    throw new TcgplayerInputError('Choose up to 20 suggested sales channels');
  }

  const ids = [];
  const seen = new Set();
  for (const publicationId of value) {
    if (
      typeof publicationId !== 'string'
      || !/^gid:\/\/shopify\/Publication\/[1-9][0-9]*$/.test(publicationId)
    ) {
      throw new TcgplayerInputError('Choose sales channels from the Shopify suggestions');
    }
    if (!seen.has(publicationId)) {
      seen.add(publicationId);
      ids.push(publicationId);
    }
  }
  return ids;
}

export function normalizeDraftFields(fields) {
  const sourceProductId = extractTcgplayerProductId(fields?.sourceUrl);
  const title = normalizedTitle(fields?.title);
  const sku = String(fields?.sku ?? '').trim();
  const descriptionHtml = sanitizeDescriptionHtml(fields?.descriptionHtml);
  const price = floorPriceToDollars(fields?.price);
  const cost = normalizeOptionalCost(fields?.cost);
  const barcode = normalizeOptionalMetadataText(fields?.barcode, 'UPC / GTIN / Barcode');
  const barcodeType = detectBarcodeType(barcode);
  const vendor = normalizeOptionalMetadataText(fields?.vendor, 'Vendor');
  const productType = normalizeOptionalMetadataText(fields?.productType, 'Product type');
  const categoryId = normalizeOptionalMetadataText(fields?.categoryId, 'Product category');
  const templateSuffix = normalizeOptionalMetadataText(fields?.templateSuffix, 'Theme template');
  const tags = normalizeProductTags(fields?.tags);
  const publicationIds = normalizePublicationIds(fields?.publicationIds);

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
    cost,
    barcode,
    barcodeType,
    vendor,
    categoryId,
    productType,
    templateSuffix,
    tags,
    publicationIds,
  };
}
