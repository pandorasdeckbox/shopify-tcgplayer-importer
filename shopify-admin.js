export class ShopifyAdminError extends Error {
  statusCode = 502;

  constructor(message = 'Shopify Admin API request failed') {
    super(message);
    this.name = 'ShopifyAdminError';
  }
}

export class PartialProductCreationError extends ShopifyAdminError {
  constructor(message) {
    super(message);
    this.name = 'PartialProductCreationError';
  }
}

function userErrorMessage(errors, fallback) {
  if (!Array.isArray(errors) || !errors.length) return fallback;
  const messages = errors.map(error => String(error?.message || '').trim()).filter(Boolean);
  return messages.length ? messages.join('; ') : fallback;
}

function userErrorMessages(errors) {
  if (!Array.isArray(errors)) return [];
  return errors.map(error => String(error?.message || '').trim()).filter(Boolean);
}

function numericProductId(gid) {
  const match = String(gid || '').match(/^gid:\/\/shopify\/Product\/([1-9][0-9]*)$/);
  return match?.[1] || null;
}

const PRODUCT_TITLE_STOP_WORDS = new Set([
  'a', 'an', 'and', 'booster', 'box', 'bundle', 'card', 'cards', 'case',
  'collection', 'deck', 'display', 'edition', 'for', 'from', 'game',
  'pack', 'product', 'series', 'set', 'starter', 'tcg', 'the', 'trading',
  'vol', 'volume', 'with',
]);
const PUBLICATION_PRODUCT_LIMIT = 25;
const PUBLICATIONS_PER_PRODUCT_LIMIT = 20;
const PUBLICATION_SUGGESTION_LIMIT = 20;

function productTitleTokens(title) {
  const words = String(title || '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .match(/[a-z0-9]+/g) || [];
  return [...new Set(words.filter(word => (
    word.length > 1
    && !/^\d+$/.test(word)
    && !PRODUCT_TITLE_STOP_WORDS.has(word)
  )))];
}

function productCatalogSearchTerms(title, productLineName, setName) {
  return [...new Set([
    ...productTitleTokens(productLineName),
    ...productTitleTokens(setName),
    ...productTitleTokens(title),
  ])].slice(0, 12);
}

function countMatchingTerms(terms, productTerms) {
  return terms.filter(term => productTerms.has(term)).length;
}

function countSuggestions(products, valueForProduct) {
  const counts = new Map();
  for (const product of products) {
    const value = valueForProduct(product);
    if (typeof value !== 'string' || !value.trim()) continue;
    const normalized = value.trim();
    const key = normalized.toLocaleLowerCase();
    const existing = counts.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      counts.set(key, { value: normalized, count: 1 });
    }
  }
  return [...counts.values()]
    .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value))
    .slice(0, 8);
}

function countProductTags(products) {
  const counts = new Map();
  for (const product of products) {
    const productTags = new Map(
      (product.tags || [])
        .filter(tag => typeof tag === 'string' && tag.trim())
        .map(tag => [tag.trim().toLocaleLowerCase(), tag.trim()]),
    );
    for (const [key, value] of productTags) {
      const existing = counts.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        counts.set(key, { value, count: 1 });
      }
    }
  }
  return [...counts.values()]
    .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value))
    .slice(0, 12);
}

function countTemplateSuggestions(products) {
  const counts = new Map();
  for (const product of products) {
    const value = typeof product.templateSuffix === 'string' ? product.templateSuffix : '';
    const key = value.toLocaleLowerCase();
    const existing = counts.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      counts.set(key, {
        value,
        label: value || 'Default product',
        count: 1,
      });
    }
  }
  return [...counts.values()]
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label))
    .slice(0, 8);
}

function buildProductMetadataSuggestions(products, title, sourceSku, { productLineName, setName } = {}) {
  const titleTerms = productTitleTokens(title);
  const productLineTerms = productTitleTokens(productLineName);
  const setTerms = productTitleTokens(setName);
  if (!titleTerms.length && !productLineTerms.length && !setTerms.length) {
    return {
      similarProductCount: 0,
      similarProducts: [],
      vendors: [],
      categories: [],
      productTypes: [],
      templates: [],
      tags: [],
      matchingProductIds: [],
    };
  }

  const hasEnoughMatches = (terms, matchCount) => (
    terms.length > 0 && matchCount >= Math.min(2, terms.length)
  );
  const similarProducts = products
    .filter(product => !sourceSku || !product.variants?.nodes?.some(variant => variant.sku === sourceSku))
    .map(product => {
      const productTerms = new Set(productTitleTokens(product.title));
      const titleMatchCount = countMatchingTerms(titleTerms, productTerms);
      const productLineMatchCount = countMatchingTerms(productLineTerms, productTerms);
      const setMatchCount = countMatchingTerms(setTerms, productTerms);
      const matchesTitle = hasEnoughMatches(titleTerms, titleMatchCount);
      const matchesProductLine = hasEnoughMatches(productLineTerms, productLineMatchCount);
      const matchesSet = hasEnoughMatches(setTerms, setMatchCount);
      return {
        ...product,
        matchesTitle,
        matchesProductLine,
        matchesSet,
        matchCount: titleMatchCount + productLineMatchCount * 2 + setMatchCount,
      };
    })
    .filter(product => product.matchesTitle || product.matchesProductLine || product.matchesSet)
    .sort((left, right) => right.matchCount - left.matchCount);
  const categories = new Map();
  for (const product of similarProducts) {
    const category = product.category;
    if (!category?.id || !category.fullName) continue;
    const existing = categories.get(category.id);
    if (existing) {
      existing.count += 1;
    } else {
      categories.set(category.id, {
        id: category.id,
        name: category.name,
        fullName: category.fullName,
        count: 1,
      });
    }
  }

  const examples = [];
  const seenTitles = new Set();
  for (const product of similarProducts) {
    const productTitle = String(product.title || '').trim();
    const key = productTitle.toLocaleLowerCase();
    if (!productTitle || seenTitles.has(key)) continue;
    seenTitles.add(key);
    examples.push({ title: productTitle, vendor: product.vendor || '' });
    if (examples.length === 3) break;
  }

  return {
    similarProductCount: similarProducts.length,
    similarProducts: examples,
    vendors: countSuggestions(similarProducts, product => product.vendor),
    categories: [...categories.values()]
      .sort((left, right) => right.count - left.count || left.fullName.localeCompare(right.fullName))
      .slice(0, 8),
    productTypes: countSuggestions(similarProducts, product => product.productType),
    templates: countTemplateSuggestions(similarProducts),
    tags: countProductTags(similarProducts),
    matchingProductIds: [...new Set(
      similarProducts.map(product => product.id)
        .filter(id => typeof id === 'string' && /^gid:\/\/shopify\/Product\/[1-9][0-9]*$/.test(id)),
    )].slice(0, PUBLICATION_PRODUCT_LIMIT),
  };
}

function buildPublicationSuggestions(productIds, products) {
  const productsById = new Map(
    products.filter(product => typeof product?.id === 'string').map(product => [product.id, product]),
  );
  const counts = new Map();

  for (const productId of productIds) {
    const seen = new Set();
    const publications = productsById.get(productId)?.resourcePublicationsV2?.nodes || [];
    for (const item of publications) {
      const publication = item?.publication;
      if (
        item?.isPublished !== true
        || typeof publication?.id !== 'string'
        || typeof publication?.catalog?.title !== 'string'
        || !publication.catalog.title.trim()
        || seen.has(publication.id)
      ) {
        continue;
      }
      seen.add(publication.id);
      const existing = counts.get(publication.id);
      if (existing) {
        existing.count += 1;
      } else {
        counts.set(publication.id, {
          id: publication.id,
          name: publication.catalog.title.trim(),
          count: 1,
        });
      }
    }
  }

  return [...counts.values()]
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name))
    .slice(0, PUBLICATION_SUGGESTION_LIMIT)
    .map(publication => ({
      ...publication,
      suggested: productIds.length > 0 && publication.count * 2 >= productIds.length,
    }));
}

export class ShopifyAdminClient {
  constructor({ apiVersion = '2026-10', fetchImpl = globalThis.fetch, timeoutMs = 30_000 } = {}) {
    this.apiVersion = apiVersion;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async graphql({ session, query, variables }) {
    if (!session?.shop || !session.accessToken) {
      throw new ShopifyAdminError('Shopify session is unavailable');
    }

    let response;
    try {
      response = await this.fetchImpl(
        `https://${session.shop}/admin/api/${this.apiVersion}/graphql.json`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Access-Token': session.accessToken,
          },
          body: JSON.stringify({ query, variables }),
          signal: AbortSignal.timeout(this.timeoutMs),
        },
      );
    } catch {
      throw new ShopifyAdminError('Could not connect to the Shopify Admin API');
    }
    if (!response.ok) {
      throw new ShopifyAdminError(`Shopify Admin API returned ${response.status}`);
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new ShopifyAdminError('Shopify Admin API returned an unreadable response');
    }
    if (payload?.errors?.length) {
      throw new ShopifyAdminError(userErrorMessage(payload.errors, 'Shopify Admin API rejected the request'));
    }
    if (!payload?.data) {
      throw new ShopifyAdminError('Shopify Admin API returned no data');
    }
    return payload.data;
  }

  async getProductMetadataSuggestions({ session, title, sku, productLineName, setName }) {
    const searchTerms = productCatalogSearchTerms(title, productLineName, setName);
    const matchContext = { productLineName, setName };
    if (!searchTerms.length) {
      const { matchingProductIds, ...suggestions } = buildProductMetadataSuggestions([], title, sku, matchContext);
      return { ...suggestions, publications: [] };
    }

    const data = await this.graphql({
      session,
      query: `query ProductMetadataSuggestions($search: String!) {
        products(first: 100, query: $search, sortKey: RELEVANCE) {
          nodes {
            id
            title
            vendor
            productType
            templateSuffix
            category { id name fullName }
            tags
            variants(first: 5) { nodes { sku } }
          }
        }
      }`,
      variables: {
        search: searchTerms.map(term => `title:${term}`).join(' OR '),
      },
    });
    const products = data.products?.nodes;
    if (!Array.isArray(products)) {
      throw new ShopifyAdminError('Shopify did not return product catalog suggestions');
    }
    const { matchingProductIds, ...suggestions } = buildProductMetadataSuggestions(products, title, sku, matchContext);
    if (!matchingProductIds.length) return { ...suggestions, publications: [] };

    const publicationData = await this.graphql({
      session,
      query: `query ProductPublicationSuggestions($productIds: [ID!]!) {
        nodes(ids: $productIds) {
          ... on Product {
            id
            resourcePublicationsV2(first: ${PUBLICATIONS_PER_PRODUCT_LIMIT}) {
              nodes {
                publication { id catalog { title } }
                isPublished
              }
            }
          }
        }
      }`,
      variables: { productIds: matchingProductIds },
    });
    if (!Array.isArray(publicationData.nodes)) {
      throw new ShopifyAdminError('Shopify did not return product publishing details');
    }
    return {
      ...suggestions,
      publications: buildPublicationSuggestions(matchingProductIds, publicationData.nodes),
    };
  }

  async uploadProductImage({ session, image }) {
    const stagedData = await this.graphql({
      session,
      query: `mutation StagedUploadsCreate($input: [StagedUploadInput!]!) {
        stagedUploadsCreate(input: $input) {
          stagedTargets {
            url
            resourceUrl
            parameters { name value }
          }
          userErrors { field message }
        }
      }`,
      variables: {
        input: [{
          filename: image.filename,
          mimeType: image.mimeType,
          httpMethod: 'POST',
          resource: 'PRODUCT_IMAGE',
        }],
      },
    });
    const stage = stagedData.stagedUploadsCreate;
    if (stage?.userErrors?.length) {
      throw new ShopifyAdminError(userErrorMessage(stage.userErrors, 'Shopify rejected the image upload'));
    }
    const target = stage?.stagedTargets?.[0];
    if (!target?.url || !target.resourceUrl || !Array.isArray(target.parameters)) {
      throw new ShopifyAdminError('Shopify did not return a usable image upload target');
    }

    const form = new FormData();
    for (const parameter of target.parameters) {
      form.append(parameter.name, parameter.value);
    }
    form.append('file', new Blob([image.buffer], { type: image.mimeType }), image.filename);

    let response;
    try {
      response = await this.fetchImpl(target.url, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new ShopifyAdminError('Could not upload the processed image to Shopify');
    }
    if (!response.ok) {
      throw new ShopifyAdminError(`Shopify image upload returned ${response.status}`);
    }
    return target.resourceUrl;
  }

  async deleteProduct({ session, productId }) {
    const data = await this.graphql({
      session,
      query: `mutation DeleteDraftProduct($productId: ID!) {
        productDelete(input: { id: $productId }) {
          deletedProductId
          userErrors { field message }
        }
      }`,
      variables: { productId },
    });
    const result = data.productDelete;
    if (result?.userErrors?.length || !result?.deletedProductId) {
      throw new ShopifyAdminError(userErrorMessage(result?.userErrors, 'Shopify could not remove the incomplete draft'));
    }
  }

  async createDraftProduct({
    session,
    title,
    descriptionHtml,
    sku,
    price,
    vendor = '',
    categoryId = '',
    productType = '',
    templateSuffix = '',
    tags = [],
    publicationIds = [],
    image,
  }) {
    const originalSource = await this.uploadProductImage({ session, image });
    const productInput = { title, descriptionHtml, status: 'DRAFT' };
    if (vendor) productInput.vendor = vendor;
    if (categoryId) productInput.category = categoryId;
    if (productType) productInput.productType = productType;
    if (templateSuffix) productInput.templateSuffix = templateSuffix;
    if (tags.length) productInput.tags = tags;
    const productData = await this.graphql({
      session,
      query: `mutation CreateDraftProduct($product: ProductCreateInput!, $media: [CreateMediaInput!]) {
        productCreate(product: $product, media: $media) {
          product {
            id
            title
            status
            featuredMedia { id }
            variants(first: 1) {
              nodes { id sku price }
            }
          }
          userErrors { field message }
        }
      }`,
      variables: {
        product: productInput,
        media: [{ originalSource, alt: title, mediaContentType: 'IMAGE' }],
      },
    });

    const created = productData.productCreate;
    const product = created?.product;
    const productId = product?.id;
    if (!product || created?.userErrors?.length) {
      if (productId) {
        try {
          await this.deleteProduct({ session, productId });
        } catch {
          const adminId = numericProductId(productId);
          throw new PartialProductCreationError(
            `Shopify created an incomplete product${adminId ? ` (${adminId})` : ''}, and automatic cleanup failed. Review it in Shopify Admin.`,
          );
        }
      }
      const messages = userErrorMessages(created?.userErrors);
      throw new ShopifyAdminError(messages.join('; ') || 'Shopify did not create the draft product');
    }

    const variantId = product.variants?.nodes?.[0]?.id;
    if (!variantId) {
      try {
        await this.deleteProduct({ session, productId });
      } catch {
        throw new PartialProductCreationError('Shopify created a draft without its expected variant, and automatic cleanup failed. Review it in Shopify Admin.');
      }
      throw new ShopifyAdminError('Shopify created a product without its default variant');
    }

    try {
      const variantData = await this.graphql({
        session,
        query: `mutation UpdateImportedVariant($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
          productVariantsBulkUpdate(productId: $productId, variants: $variants) {
            productVariants {
              id
              price
              inventoryItem { sku }
            }
            userErrors { field message }
          }
        }`,
        variables: {
          productId,
          variants: [{
            id: variantId,
            price,
            inventoryItem: { sku },
          }],
        },
      });
      const update = variantData.productVariantsBulkUpdate;
      if (update?.userErrors?.length || !update?.productVariants?.length) {
        throw new ShopifyAdminError(userErrorMessage(update?.userErrors, 'Shopify did not update the default variant'));
      }
    } catch (error) {
      try {
        await this.deleteProduct({ session, productId });
      } catch {
        const adminId = numericProductId(productId);
        throw new PartialProductCreationError(
          `Shopify created draft product ${adminId || productId}, but variant setup failed and automatic cleanup failed. Review it in Shopify Admin.`,
        );
      }
      throw error;
    }

    if (publicationIds.length) {
      try {
        const publicationData = await this.graphql({
          session,
          query: `mutation SelectDraftProductPublications($id: ID!, $input: [PublicationInput!]!) {
            publishablePublish(id: $id, input: $input) {
              publishable {
                ... on Product { id status }
              }
              userErrors { field message }
            }
          }`,
          variables: {
            id: productId,
            input: publicationIds.map(publicationId => ({ publicationId })),
          },
        });
        const result = publicationData.publishablePublish;
        if (result?.userErrors?.length || result?.publishable?.status !== 'DRAFT') {
          throw new ShopifyAdminError(userErrorMessage(
            result?.userErrors,
            'Shopify did not keep the selected sales channels on a Draft product',
          ));
        }
      } catch (error) {
        try {
          await this.deleteProduct({ session, productId });
        } catch {
          const adminId = numericProductId(productId);
          throw new PartialProductCreationError(
            `Shopify created a draft product ${adminId || productId}, but sales-channel assignment failed and automatic cleanup failed. Review it in Shopify Admin.`,
          );
        }
        throw error;
      }
    }

    const adminId = numericProductId(productId);
    if (!adminId) {
      throw new ShopifyAdminError('Shopify created a product with an unexpected ID');
    }
    return {
      id: productId,
      numericId: adminId,
      title: product.title,
      status: product.status,
      sku,
      price,
      adminUrl: `https://${session.shop}/admin/products/${adminId}`,
    };
  }
}
