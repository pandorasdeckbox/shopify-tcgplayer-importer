import test from 'node:test';
import assert from 'node:assert/strict';
import { ShopifyAdminClient, ShopifyAdminError } from '../shopify-admin.js';

const session = {
  shop: 'example-store.myshopify.com',
  accessToken: 'test-access-token',
};
const image = {
  buffer: Buffer.from('processed-image'),
  filename: 'tcgplayer-711385.jpg',
  mimeType: 'image/jpeg',
};

function response(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function successfulShopifyFetch(requests) {
  return async (url, options) => {
    requests.push({ url, options });
    if (url === 'https://staged-upload.example.com') {
      return new Response(null, { status: 204 });
    }
    const body = JSON.parse(options.body);
    if (body.query.includes('stagedUploadsCreate')) {
      return response({
        data: {
          stagedUploadsCreate: {
            stagedTargets: [{
              url: 'https://staged-upload.example.com',
              resourceUrl: 'https://staged-resource.example.com/image.jpg',
              parameters: [{ name: 'key', value: 'image-key' }],
            }],
            userErrors: [],
          },
        },
      });
    }
    if (body.query.includes('productCreate')) {
      return response({
        data: {
          productCreate: {
            product: {
              id: 'gid://shopify/Product/9001',
              title: 'Booster Box',
              status: 'DRAFT',
              featuredMedia: { id: 'gid://shopify/MediaImage/1' },
              variants: { nodes: [{ id: 'gid://shopify/ProductVariant/9002' }] },
            },
            userErrors: [],
            mediaUserErrors: [],
          },
        },
      });
    }
    if (body.query.includes('productVariantsBulkUpdate')) {
      return response({
        data: {
          productVariantsBulkUpdate: {
            productVariants: [{
              id: 'gid://shopify/ProductVariant/9002',
              price: '266.00',
              inventoryItem: { sku: '711385' },
            }],
            userErrors: [],
          },
        },
      });
    }
    throw new Error(`Unexpected request: ${body.query}`);
  };
}

test('uploads an image and creates a Draft product with the default variant SKU and price', async () => {
  const requests = [];
  const client = new ShopifyAdminClient({ fetchImpl: successfulShopifyFetch(requests) });
  const product = await client.createDraftProduct({
    session,
    title: 'Booster Box',
    descriptionHtml: '<p>Description</p>',
    sku: '711385',
    price: '266.00',
    image,
  });

  assert.equal(product.numericId, '9001');
  assert.equal(product.status, 'DRAFT');
  assert.equal(product.sku, '711385');
  assert.equal(product.price, '266.00');
  assert.equal(product.adminUrl, 'https://example-store.myshopify.com/admin/products/9001');

  const createRequest = requests.find(request => request.url.endsWith('/graphql.json') && JSON.parse(request.options.body).query.includes('productCreate'));
  const createVariables = JSON.parse(createRequest.options.body).variables;
  assert.equal(createVariables.product.status, 'DRAFT');
  assert.equal(createVariables.product.title, 'Booster Box');
  assert.deepEqual(createVariables.media, [{
    originalSource: 'https://staged-resource.example.com/image.jpg',
    alt: 'Booster Box',
    mediaContentType: 'IMAGE',
  }]);

  const variantRequest = requests.find(request => request.url.endsWith('/graphql.json') && JSON.parse(request.options.body).query.includes('productVariantsBulkUpdate'));
  const variantVariables = JSON.parse(variantRequest.options.body).variables;
  assert.deepEqual(variantVariables.variants, [{
    id: 'gid://shopify/ProductVariant/9002',
    price: '266.00',
    inventoryItem: { sku: '711385' },
  }]);

  const upload = requests.find(request => request.url === 'https://staged-upload.example.com');
  assert.equal(upload.options.method, 'POST');
  assert.equal(upload.options.body.get('key'), 'image-key');
  assert.equal(upload.options.body.get('file').name, 'tcgplayer-711385.jpg');
});

test('deletes a newly created product if its variant cannot be updated', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    if (url === 'https://staged-upload.example.com') return new Response(null, { status: 204 });
    const body = JSON.parse(options.body);
    if (body.query.includes('stagedUploadsCreate')) {
      return response({
        data: {
          stagedUploadsCreate: {
            stagedTargets: [{
              url: 'https://staged-upload.example.com',
              resourceUrl: 'https://staged-resource.example.com/image.jpg',
              parameters: [],
            }],
            userErrors: [],
          },
        },
      });
    }
    if (body.query.includes('productCreate')) {
      return response({
        data: {
          productCreate: {
            product: {
              id: 'gid://shopify/Product/9001',
              title: 'Booster Box',
              status: 'DRAFT',
              variants: { nodes: [{ id: 'gid://shopify/ProductVariant/9002' }] },
            },
            userErrors: [],
            mediaUserErrors: [],
          },
        },
      });
    }
    if (body.query.includes('productVariantsBulkUpdate')) {
      return response({
        data: {
          productVariantsBulkUpdate: {
            productVariants: [],
            userErrors: [{ message: 'SKU is invalid' }],
          },
        },
      });
    }
    if (body.query.includes('productDelete')) {
      return response({
        data: {
          productDelete: {
            deletedProductId: 'gid://shopify/Product/9001',
            userErrors: [],
          },
        },
      });
    }
    throw new Error(`Unexpected request: ${body.query}`);
  };
  const client = new ShopifyAdminClient({ fetchImpl });

  await assert.rejects(
    client.createDraftProduct({
      session,
      title: 'Booster Box',
      descriptionHtml: '<p>Description</p>',
      sku: 'bad',
      price: '266.00',
      image,
    }),
    error => error instanceof ShopifyAdminError && /SKU is invalid/.test(error.message),
  );
  assert.ok(requests.some(request => request.url.endsWith('/graphql.json') && JSON.parse(request.options.body).query.includes('productDelete')));
});

test('surfaces GraphQL errors instead of returning partial success', async () => {
  const client = new ShopifyAdminClient({
    fetchImpl: async () => response({ errors: [{ message: 'Access denied' }] }),
  });
  await assert.rejects(
    client.graphql({ session, query: 'query { shop { name } }', variables: {} }),
    error => error instanceof ShopifyAdminError && /Access denied/.test(error.message),
  );
});
