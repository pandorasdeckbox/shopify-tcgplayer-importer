/** @jsxImportSource preact */
import { render } from 'preact';
import { useState } from 'preact/hooks';

async function postJson(path, body) {
  const token = await shopify.auth.idToken();
  const response = await fetch(path, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error('The app returned an unreadable response.');
  }
  if (!response.ok) {
    throw new Error(payload?.error || 'The request could not be completed.');
  }
  return payload;
}

export default async () => {
  render(<Extension />, document.body);
};

function Extension() {
  const { close, i18n } = shopify;
  const [url, setUrl] = useState('');
  const [product, setProduct] = useState(null);
  const [createdProduct, setCreatedProduct] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [tagsText, setTagsText] = useState('');
  const [publicationIds, setPublicationIds] = useState([]);

  const lookup = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await postJson('/api/import/preview', { url });
      setProduct(result.product);
      setTagsText((result.product.tags || []).join(', '));
      setPublicationIds(result.product.publicationIds || []);
      setCreatedProduct(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : i18n.translate('error-title'));
    } finally {
      setBusy(false);
    }
  };

  const createDraft = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await postJson('/api/import/create', {
        sourceUrl: product.sourceUrl,
        title: product.title,
        sku: product.sku,
        price: product.price,
        descriptionHtml: product.descriptionHtml,
        vendor: product.vendor,
        categoryId: product.categoryId,
        productType: product.productType,
        templateSuffix: product.templateSuffix,
        tags: tagsText,
        publicationIds,
      });
      setCreatedProduct(result.product);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : i18n.translate('error-title'));
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    setUrl('');
    setProduct(null);
    setCreatedProduct(null);
    setTagsText('');
    setPublicationIds([]);
    setError('');
  };

  const catalogSuggestions = product?.catalogSuggestions || {
    similarProductCount: 0,
    similarProducts: [],
    vendors: [],
    categories: [],
    productTypes: [],
    templates: [],
    tags: [],
    publications: [],
  };
  const defaultTemplateSuggestion = catalogSuggestions.templates.find(item => !item.value);
  const suggestionText = suggestions => suggestions
    .map(suggestion => `${suggestion.value} (${suggestion.count})`)
    .join(', ');

  return (
    <s-admin-action heading={i18n.translate('extension-name')}>
      {createdProduct ? (
        <>
          <s-banner tone="success">{i18n.translate('success')}</s-banner>
          <s-text>{createdProduct.title}</s-text>
          <s-link href={createdProduct.adminUrl} target="_blank">
            {createdProduct.sku} · ${createdProduct.price}
          </s-link>
          <s-button slot="secondary-actions" onClick={close}>
            {i18n.translate('cancel')}
          </s-button>
        </>
      ) : (
        <>
          {error ? <s-banner tone="critical">{error}</s-banner> : null}
          {!product ? (
            <s-text-field
              label={i18n.translate('url-label')}
              placeholder={i18n.translate('url-placeholder')}
              value={url}
              onChange={event => setUrl(event.currentTarget.value)}
              disabled={busy}
            />
          ) : (
            <>
              <s-banner tone="info">{i18n.translate('edit-note')}</s-banner>
              <s-image
                src={product.imagePreviewDataUrl}
                alt={product.title}
                aspectRatio="1/1"
                objectFit="contain"
                inlineSize="fill"
              />
              <s-text-field
                label={i18n.translate('title-label')}
                value={product.title}
                onChange={event => setProduct({ ...product, title: event.currentTarget.value })}
                disabled={busy}
              />
              <s-text-field
                label={i18n.translate('sku-label')}
                value={product.sku}
                onChange={event => setProduct({ ...product, sku: event.currentTarget.value })}
                disabled={busy}
              />
              <s-text-field
                label={i18n.translate('price-label')}
                value={product.price}
                onChange={event => setProduct({ ...product, price: event.currentTarget.value })}
                disabled={busy}
              />
              <s-text-area
                label={i18n.translate('description-label')}
                value={product.descriptionHtml}
                onChange={event => setProduct({ ...product, descriptionHtml: event.currentTarget.value })}
                disabled={busy}
              />
              <s-text>
                {catalogSuggestions.similarProductCount
                  ? `${i18n.translate('catalog-suggestions')} (${catalogSuggestions.similarProductCount}): ${catalogSuggestions.similarProducts.map(item => item.title).join('; ')}`
                  : i18n.translate('no-similar-products')}
              </s-text>
              <s-text-field
                label={i18n.translate('vendor-label')}
                value={product.vendor}
                onChange={event => setProduct({ ...product, vendor: event.currentTarget.value })}
                disabled={busy}
              />
              {catalogSuggestions.vendors.length ? (
                <s-text>{`${i18n.translate('vendor-suggestions')}: ${suggestionText(catalogSuggestions.vendors)}`}</s-text>
              ) : null}
              <s-select
                label={i18n.translate('category-label')}
                value={product.categoryId}
                onChange={event => setProduct({ ...product, categoryId: event.currentTarget.value })}
                disabled={busy}
              >
                <s-option value="">{i18n.translate('no-category')}</s-option>
                {catalogSuggestions.categories.map(category => (
                  <s-option key={category.id} value={category.id}>
                    {`${category.fullName || category.name} (${category.count})`}
                  </s-option>
                ))}
              </s-select>
              <s-text-field
                label={i18n.translate('type-label')}
                value={product.productType}
                onChange={event => setProduct({ ...product, productType: event.currentTarget.value })}
                disabled={busy}
              />
              {catalogSuggestions.productTypes.length ? (
                <s-text>{`${i18n.translate('type-suggestions')}: ${suggestionText(catalogSuggestions.productTypes)}`}</s-text>
              ) : null}
              <s-select
                label={i18n.translate('template-label')}
                value={product.templateSuffix}
                onChange={event => setProduct({ ...product, templateSuffix: event.currentTarget.value })}
                disabled={busy}
              >
                <s-option value="">
                  {`Default product${defaultTemplateSuggestion ? ` (${defaultTemplateSuggestion.count})` : ''}`}
                </s-option>
                {catalogSuggestions.templates.filter(item => item.value).map(template => (
                  <s-option key={template.value} value={template.value}>
                    {`${template.label} (${template.count})`}
                  </s-option>
                ))}
              </s-select>
              <s-text-field
                label={i18n.translate('tags-label')}
                value={tagsText}
                onChange={event => setTagsText(event.currentTarget.value)}
                disabled={busy}
              />
              {catalogSuggestions.tags.length ? (
                <s-text>{`${i18n.translate('tag-suggestions')}: ${suggestionText(catalogSuggestions.tags)}`}</s-text>
              ) : null}
              <s-text>{i18n.translate('publishing-label')}</s-text>
              {catalogSuggestions.publications.length ? (
                <s-stack gap="none">
                  {catalogSuggestions.publications.map(publication => (
                    <s-checkbox
                      key={publication.id}
                      label={`${publication.name} (${publication.count})`}
                      checked={publicationIds.includes(publication.id)}
                      disabled={busy}
                      onChange={event => {
                        const checked = event.currentTarget.checked;
                        setPublicationIds(current => (
                          checked
                            ? current.includes(publication.id) ? current : [...current, publication.id]
                            : current.filter(id => id !== publication.id)
                        ));
                      }}
                    />
                  ))}
                </s-stack>
              ) : (
                <s-text>{i18n.translate('no-publishing-suggestions')}</s-text>
              )}
              <s-text>{i18n.translate('publishing-note')}</s-text>
              <s-text>{i18n.translate('image-note')}</s-text>
            </>
          )}
          {busy ? <s-text>{product ? i18n.translate('creating') : i18n.translate('loading')}</s-text> : null}
          <s-button
            slot="primary-action"
            onClick={product ? createDraft : lookup}
            disabled={busy || (!product && !url.trim())}
            loading={busy}
          >
            {product ? i18n.translate('create') : i18n.translate('lookup')}
          </s-button>
          <s-button
            slot="secondary-actions"
            onClick={product ? reset : close}
            disabled={busy}
          >
            {product ? i18n.translate('start-over') : i18n.translate('cancel')}
          </s-button>
        </>
      )}
    </s-admin-action>
  );
}
