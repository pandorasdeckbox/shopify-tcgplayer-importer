/** @jsxImportSource preact */
import { render } from 'preact';
import { useState } from 'preact/hooks';

async function postJson(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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

  const lookup = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await postJson('/api/import/preview', { url });
      setProduct(result.product);
      setCreatedProduct(null);
    } catch (requestError) {
      setError(requestError.message);
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
      });
      setCreatedProduct(result.product);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    setUrl('');
    setProduct(null);
    setCreatedProduct(null);
    setError('');
  };

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
              onChange={event => setUrl(event.target.value)}
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
                onChange={event => setProduct({ ...product, title: event.target.value })}
                disabled={busy}
              />
              <s-text-field
                label={i18n.translate('sku-label')}
                value={product.sku}
                onChange={event => setProduct({ ...product, sku: event.target.value })}
                disabled={busy}
              />
              <s-text-field
                label={i18n.translate('price-label')}
                value={product.price}
                onChange={event => setProduct({ ...product, price: event.target.value })}
                disabled={busy}
              />
              <s-text-area
                label={i18n.translate('description-label')}
                value={product.descriptionHtml}
                onChange={event => setProduct({ ...product, descriptionHtml: event.target.value })}
                disabled={busy}
              />
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
