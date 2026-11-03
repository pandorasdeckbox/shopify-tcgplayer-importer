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

  async createDraftProduct({ session, title, descriptionHtml, sku, price, image }) {
    const originalSource = await this.uploadProductImage({ session, image });
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
          mediaUserErrors { field message }
        }
      }`,
      variables: {
        product: { title, descriptionHtml, status: 'DRAFT' },
        media: [{ originalSource, alt: title, mediaContentType: 'IMAGE' }],
      },
    });

    const created = productData.productCreate;
    const product = created?.product;
    const productId = product?.id;
    if (!product || created?.userErrors?.length || created?.mediaUserErrors?.length) {
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
      const messages = [
        ...userErrorMessages(created?.userErrors),
        ...userErrorMessages(created?.mediaUserErrors),
      ];
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
