const lookupPanel = document.querySelector('#lookup-panel');
const lookupForm = document.querySelector('#lookup-form');
const urlInput = document.querySelector('#tcgplayer-url');
const fetchButton = document.querySelector('#fetch-button');
const previewPanel = document.querySelector('#preview-panel');
const productForm = document.querySelector('#product-form');
const productImage = document.querySelector('#product-image');
const titleInput = document.querySelector('#product-title');
const skuInput = document.querySelector('#product-sku');
const priceInput = document.querySelector('#product-price');
const descriptionInput = document.querySelector('#product-description');
const createButton = document.querySelector('#create-button');
const startOverButton = document.querySelector('#start-over-button');
const successPanel = document.querySelector('#success-panel');
const createdTitle = document.querySelector('#created-title');
const createdDetails = document.querySelector('#created-details');
const createdLink = document.querySelector('#created-link');
const anotherImportButton = document.querySelector('#another-import-button');
const statusMessage = document.querySelector('#import-status');
const errorMessage = document.querySelector('#import-error');

let product = null;

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

function setBusy(busy, message = '') {
  urlInput.disabled = busy;
  fetchButton.disabled = busy;
  createButton.disabled = busy;
  startOverButton.disabled = busy;
  anotherImportButton.disabled = busy;
  statusMessage.textContent = message;
}

function showError(error) {
  errorMessage.textContent = error;
  errorMessage.hidden = !error;
}

function showPreview(nextProduct) {
  product = nextProduct;
  productImage.src = product.imagePreviewDataUrl;
  productImage.alt = product.title;
  titleInput.value = product.title;
  skuInput.value = product.sku;
  priceInput.value = product.price;
  descriptionInput.value = product.descriptionHtml;
  lookupPanel.hidden = true;
  successPanel.hidden = true;
  previewPanel.hidden = false;
}

function resetImport() {
  product = null;
  lookupForm.reset();
  productForm.reset();
  productImage.removeAttribute('src');
  productImage.alt = '';
  lookupPanel.hidden = false;
  previewPanel.hidden = true;
  successPanel.hidden = true;
  showError('');
  setBusy(false);
  urlInput.focus();
}

lookupForm.addEventListener('submit', async event => {
  event.preventDefault();
  showError('');
  setBusy(true, 'Fetching product details and preparing the image...');

  try {
    const result = await postJson('/api/import/preview', { url: urlInput.value });
    if (!result.product) throw new Error('The app did not return product details.');
    showPreview(result.product);
  } catch (error) {
    showError(error instanceof Error ? error.message : 'The product could not be fetched.');
  } finally {
    setBusy(false);
  }
});

productForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (!product) return;

  showError('');
  setBusy(true, 'Creating Draft product...');

  try {
    const result = await postJson('/api/import/create', {
      sourceUrl: product.sourceUrl,
      title: titleInput.value,
      sku: skuInput.value,
      price: priceInput.value,
      descriptionHtml: descriptionInput.value,
    });
    if (!result.product?.adminUrl) throw new Error('Shopify created the product but did not return its admin link.');
    createdTitle.textContent = result.product.title;
    createdDetails.textContent = `${result.product.sku} · $${result.product.price}`;
    createdLink.href = result.product.adminUrl;
    previewPanel.hidden = true;
    successPanel.hidden = false;
    statusMessage.textContent = 'Draft product created.';
  } catch (error) {
    showError(error instanceof Error ? error.message : 'The Draft product could not be created.');
  } finally {
    setBusy(false);
  }
});

startOverButton.addEventListener('click', resetImport);
anotherImportButton.addEventListener('click', resetImport);
