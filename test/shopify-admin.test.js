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

function successfulShopifyFetch(requests, { failInventoryActivation = false } = {}) {
  return async (url, options) => {
    requests.push({ url, options });
    if (url === 'https://staged-upload.example.com') {
      return new Response(null, { status: 204 });
    }
    const body = JSON.parse(options.body);
    if (body.query.includes('ActiveInventoryLocations')) {
      return response({
        data: {
          locations: body.variables.after
            ? {
              nodes: [{ id: 'gid://shopify/Location/3002' }],
              pageInfo: { hasNextPage: false, endCursor: null },
            }
            : {
              nodes: [{ id: 'gid://shopify/Location/3001' }],
              pageInfo: { hasNextPage: true, endCursor: 'inventory-location-page-2' },
            },
        },
      });
    }
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
              inventoryPolicy: 'DENY',
              inventoryItem: {
                id: 'gid://shopify/InventoryItem/9003',
                sku: '711385',
                tracked: true,
              },
            }],
            userErrors: [],
          },
        },
      });
    }
    if (body.query.includes('inventoryActivate')) {
      return response({
        data: {
          inventoryActivate: {
            inventoryLevel: {
              id: `gid://shopify/InventoryLevel/${body.variables.locationId.split('/').at(-1)}`,
              quantities: [{ name: 'available', quantity: 0 }],
            },
            userErrors: failInventoryActivation
              ? [{ field: ['locationId'], message: 'Inventory activation denied' }]
              : [],
          },
        },
      });
    }
    if (body.query.includes('publishablePublish')) {
      return response({
        data: {
          publishablePublish: {
            publishable: {
              id: 'gid://shopify/Product/9001',
              status: 'DRAFT',
            },
            userErrors: [],
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
}

test('creates a Draft product with its suggested sales channels', async () => {
  const requests = [];
  const client = new ShopifyAdminClient({ fetchImpl: successfulShopifyFetch(requests) });
  const product = await client.createDraftProduct({
    session,
    title: 'Booster Box',
    descriptionHtml: '<p>Description</p>',
    sku: '711385',
    price: '266.00',
    vendor: 'Bandai',
    categoryId: 'gid://shopify/TaxonomyCategory/aa-1-2',
    productType: 'Trading Card Game',
    templateSuffix: 'card-game',
    tags: ['One Piece'],
    publicationIds: ['gid://shopify/Publication/100'],
    image,
  });

  assert.equal(product.numericId, '9001');
  assert.equal(product.status, 'DRAFT');
  assert.equal(product.sku, '711385');
  assert.equal(product.price, '266.00');
  assert.equal(product.adminUrl, 'https://example-store.myshopify.com/admin/products/9001');

  const createRequest = requests.find(request => request.url.endsWith('/graphql.json') && JSON.parse(request.options.body).query.includes('productCreate'));
  const createBody = JSON.parse(createRequest.options.body);
  const createVariables = createBody.variables;
  assert.doesNotMatch(createBody.query, /\bmediaUserErrors\b/);
  assert.equal(createVariables.product.status, 'DRAFT');
  assert.equal(createVariables.product.title, 'Booster Box');
  assert.equal(createVariables.product.vendor, 'Bandai');
  assert.equal(createVariables.product.category, 'gid://shopify/TaxonomyCategory/aa-1-2');
  assert.equal(createVariables.product.productType, 'Trading Card Game');
  assert.equal(createVariables.product.templateSuffix, 'card-game');
  assert.deepEqual(createVariables.product.tags, ['One Piece']);
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
    inventoryPolicy: 'DENY',
    inventoryItem: { sku: '711385', tracked: true },
  }]);

  const inventoryRequests = requests.filter(request => (
    request.url.endsWith('/graphql.json')
    && JSON.parse(request.options.body).query.includes('inventoryActivate')
  ));
  assert.equal(inventoryRequests.length, 2);
  assert.deepEqual(inventoryRequests.map(request => JSON.parse(request.options.body).variables.locationId), [
    'gid://shopify/Location/3001',
    'gid://shopify/Location/3002',
  ]);
  for (const request of inventoryRequests) {
    const body = JSON.parse(request.options.body);
    assert.equal(body.variables.inventoryItemId, 'gid://shopify/InventoryItem/9003');
    assert.match(body.variables.idempotencyKey, /^[0-9a-f-]{36}$/);
    assert.match(body.query, /available:\s*0/);
    assert.match(body.query, /onHand:\s*0/);
    assert.match(body.query, /@idempotent\(key:\s*\$idempotencyKey\)/);
  }

  const publicationRequest = requests.find(request => (
    request.url.endsWith('/graphql.json')
    && JSON.parse(request.options.body).query.includes('publishablePublish')
  ));
  const publicationBody = JSON.parse(publicationRequest.options.body);
  assert.deepEqual(publicationBody.variables.input, [
    { publicationId: 'gid://shopify/Publication/100' },
  ]);
  assert.match(publicationBody.query, /status/);

  const upload = requests.find(request => request.url === 'https://staged-upload.example.com');
  assert.equal(upload.options.method, 'POST');
  assert.equal(upload.options.body.get('key'), 'image-key');
  assert.equal(upload.options.body.get('file').name, 'tcgplayer-711385.jpg');
});

test('deletes the Draft product if Shopify cannot confirm zero inventory', async () => {
  const requests = [];
  const client = new ShopifyAdminClient({
    fetchImpl: successfulShopifyFetch(requests, { failInventoryActivation: true }),
  });

  await assert.rejects(
    client.createDraftProduct({
      session,
      title: 'Booster Box',
      descriptionHtml: '<p>Description</p>',
      sku: '711385',
      price: '266.00',
      image,
    }),
    error => error instanceof ShopifyAdminError && /Inventory activation denied/.test(error.message),
  );
  assert.ok(requests.some(request => (
    request.url.endsWith('/graphql.json')
    && JSON.parse(request.options.body).query.includes('productDelete')
  )));
});

test('suggests metadata from matching Shopify catalog products', async () => {
  const requests = [];
  const client = new ShopifyAdminClient({
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      const body = JSON.parse(options.body);
      if (body.query.includes('ProductPublicationSuggestions')) {
        return response({
          data: {
            nodes: [
              {
                id: 'gid://shopify/Product/9002',
                resourcePublicationsV2: {
                  nodes: [
                    { publication: { id: 'gid://shopify/Publication/100', catalog: { title: 'Online Store' } }, isPublished: true },
                    { publication: { id: 'gid://shopify/Publication/200', catalog: { title: 'Point of Sale' } }, isPublished: true },
                  ],
                },
              },
              {
                id: 'gid://shopify/Product/9003',
                resourcePublicationsV2: {
                  nodes: [
                    { publication: { id: 'gid://shopify/Publication/100', catalog: { title: 'Online Store' } }, isPublished: true },
                    { publication: { id: 'gid://shopify/Publication/300', catalog: { title: 'Shop' } }, isPublished: true },
                  ],
                },
              },
              {
                id: 'gid://shopify/Product/9004',
                resourcePublicationsV2: {
                  nodes: [
                    { publication: { id: 'gid://shopify/Publication/100', catalog: { title: 'Online Store' } }, isPublished: true },
                  ],
                },
              },
            ],
          },
        });
      }
      return response({
        data: {
          products: {
            nodes: [
              {
                id: 'gid://shopify/Product/9001',
                title: 'One Piece Heroines Booster Box',
                vendor: 'Wrong default vendor',
                productType: 'Uncategorized',
                templateSuffix: 'wrong-default',
                category: { id: 'gid://shopify/TaxonomyCategory/other', name: 'Other', fullName: 'Other' },
                tags: ['Wrong default'],
                variants: { nodes: [{ sku: '711385' }] },
              },
              {
                id: 'gid://shopify/Product/9002',
                title: 'One Piece Starter Deck',
                vendor: 'Bandai',
                productType: 'Trading Card Game',
                templateSuffix: '',
                category: {
                  id: 'gid://shopify/TaxonomyCategory/aa-1-2',
                  name: 'Trading Cards',
                  fullName: 'Toys & Games > Games > Trading Cards',
                },
                tags: ['One Piece', 'Card Game'],
                variants: { nodes: [{ sku: 'OP01' }] },
              },
              {
                id: 'gid://shopify/Product/9003',
                title: 'One Piece Romance Dawn Booster Box',
                vendor: 'Bandai',
                productType: 'Trading Card Game',
                templateSuffix: 'card-game',
                category: {
                  id: 'gid://shopify/TaxonomyCategory/aa-1-2',
                  name: 'Trading Cards',
                  fullName: 'Toys & Games > Games > Trading Cards',
                },
                tags: ['One Piece', 'Booster Box'],
                variants: { nodes: [{ sku: 'OP02' }] },
              },
              {
                id: 'gid://shopify/Product/9004',
                title: 'One Piece Heroines Booster Pack',
                vendor: '',
                productType: '',
                category: null,
                tags: [],
                variants: { nodes: [{ sku: 'OP03' }] },
              },
              {
                id: 'gid://shopify/Product/9005',
                title: 'Pokemon Elite Trainer Box',
                vendor: 'Pokemon',
                productType: 'Cards',
                category: null,
                tags: ['Pokemon'],
                variants: { nodes: [{ sku: 'PK01' }] },
              },
            ],
          },
        },
      });
    },
  });

  const suggestions = await client.getProductMetadataSuggestions({
    session,
    title: 'Extra Booster: One Piece Heroines Edition Vol.2 - Booster Box',
    sku: '711385',
  });

  assert.equal(suggestions.similarProductCount, 3);
  assert.deepEqual(suggestions.vendors, [{ value: 'Bandai', count: 2 }]);
  assert.deepEqual(suggestions.categories, [{
    id: 'gid://shopify/TaxonomyCategory/aa-1-2',
    name: 'Trading Cards',
    fullName: 'Toys & Games > Games > Trading Cards',
    count: 2,
  }]);
  assert.deepEqual(suggestions.productTypes, [{ value: 'Trading Card Game', count: 2 }]);
  assert.equal(suggestions.templates.find(template => !template.value).count, 2);
  assert.deepEqual(suggestions.templates.find(template => template.value), {
    value: 'card-game',
    label: 'card-game',
    count: 1,
  });
  assert.deepEqual(suggestions.tags, [
    { value: 'One Piece', count: 2 },
    { value: 'Booster Box', count: 1 },
    { value: 'Card Game', count: 1 },
  ]);
  assert.deepEqual(suggestions.similarProducts.map(product => product.title), [
    'One Piece Heroines Booster Pack',
    'One Piece Starter Deck',
    'One Piece Romance Dawn Booster Box',
  ]);
  assert.deepEqual(suggestions.publications, [
    { id: 'gid://shopify/Publication/100', name: 'Online Store', count: 3, suggested: true },
    { id: 'gid://shopify/Publication/200', name: 'Point of Sale', count: 1, suggested: false },
    { id: 'gid://shopify/Publication/300', name: 'Shop', count: 1, suggested: false },
  ]);

  const request = requests[0];
  const body = JSON.parse(request.options.body);
  assert.match(body.query, /category \{ id name fullName \}/);
  assert.match(body.query, /nodes\s*\{\s*id/);
  assert.equal(
    body.variables.search,
    'title:extra OR title:one OR title:piece OR title:heroines',
  );
  const publicationRequest = requests[1];
  const publicationBody = JSON.parse(publicationRequest.options.body);
  assert.deepEqual(publicationBody.variables.productIds, [
    'gid://shopify/Product/9004',
    'gid://shopify/Product/9002',
    'gid://shopify/Product/9003',
  ]);
  assert.match(publicationBody.query, /resourcePublicationsV2/);
});

test('matches catalog products using TCGplayer product-line and set breadcrumb context', async () => {
  const requests = [];
  const client = new ShopifyAdminClient({
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      const body = JSON.parse(options.body);
      if (body.query.includes('ProductPublicationSuggestions')) {
        return response({ data: { nodes: [] } });
      }
      return response({
        data: {
          products: {
            nodes: [
              {
                id: 'gid://shopify/Product/9101',
                title: "The World's Strongest Warriors Booster Box",
                vendor: 'Wrong default vendor',
                productType: 'Uncategorized',
                category: null,
                tags: [],
                variants: { nodes: [{ sku: '704752' }] },
              },
              {
                id: 'gid://shopify/Product/9102',
                title: 'One Piece Heroines Edition Booster Box',
                vendor: 'Bandai',
                productType: 'Trading Card Game',
                templateSuffix: '',
                category: {
                  id: 'gid://shopify/TaxonomyCategory/aa-1-2',
                  name: 'Trading Cards',
                  fullName: 'Toys & Games > Games > Trading Cards',
                },
                tags: ['One Piece', 'Booster Box'],
                variants: { nodes: [{ sku: '711385' }] },
              },
              {
                id: 'gid://shopify/Product/9103',
                title: 'One Piece Heroines Edition Booster Pack',
                vendor: 'Bandai',
                productType: 'Trading Card Game',
                templateSuffix: '',
                category: {
                  id: 'gid://shopify/TaxonomyCategory/aa-1-2',
                  name: 'Trading Cards',
                  fullName: 'Toys & Games > Games > Trading Cards',
                },
                tags: ['One Piece', 'Booster Pack'],
                variants: { nodes: [{ sku: '711386' }] },
              },
              {
                id: 'gid://shopify/Product/9104',
                title: 'Pokemon Booster Box',
                vendor: 'Pokemon',
                productType: 'Cards',
                category: null,
                tags: ['Pokemon'],
                variants: { nodes: [{ sku: 'PK01' }] },
              },
            ],
          },
        },
      });
    },
  });

  const suggestions = await client.getProductMetadataSuggestions({
    session,
    title: "The World's Strongest Warriors Booster Box",
    sku: '704752',
    productLineName: 'One Piece Card Game',
    setName: "The World's Strongest Warriors",
  });

  assert.equal(suggestions.similarProductCount, 2);
  assert.deepEqual(suggestions.vendors, [{ value: 'Bandai', count: 2 }]);
  assert.deepEqual(suggestions.productTypes, [{ value: 'Trading Card Game', count: 2 }]);
  assert.deepEqual(suggestions.similarProducts.map(product => product.title), [
    'One Piece Heroines Edition Booster Box',
    'One Piece Heroines Edition Booster Pack',
  ]);

  const body = JSON.parse(requests[0].options.body);
  assert.equal(
    body.variables.search,
    'title:one OR title:piece OR title:world OR title:strongest OR title:warriors',
  );
});

test('deletes a newly created product if its variant cannot be updated', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    if (url === 'https://staged-upload.example.com') return new Response(null, { status: 204 });
    const body = JSON.parse(options.body);
    if (body.query.includes('ActiveInventoryLocations')) {
      return response({
        data: {
          locations: {
            nodes: [{ id: 'gid://shopify/Location/3001' }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      });
    }
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
