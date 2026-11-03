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
const vendorInput = document.querySelector('#product-vendor');
const categoryInput = document.querySelector('#product-category');
const productTypeInput = document.querySelector('#product-type');
const templateInput = document.querySelector('#product-template');
const tagsInput = document.querySelector('#product-tags');
const vendorSuggestions = document.querySelector('#vendor-suggestions');
const productTypeSuggestions = document.querySelector('#product-type-suggestions');
const catalogSuggestionSummary = document.querySelector('#catalog-suggestion-summary');
const tagSuggestions = document.querySelector('#tag-suggestions');
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
  vendorInput.disabled = busy;
  categoryInput.disabled = busy;
  productTypeInput.disabled = busy;
  templateInput.disabled = busy;
  tagsInput.disabled = busy;
  for (const button of tagSuggestions.querySelectorAll('button')) button.disabled = busy;
  createButton.disabled = busy;
  startOverButton.disabled = busy;
  anotherImportButton.disabled = busy;
  statusMessage.textContent = message;
}

function showError(error) {
  errorMessage.textContent = error;
  errorMessage.hidden = !error;
}

function populateDatalist(datalist, suggestions) {
  datalist.replaceChildren();
  for (const suggestion of suggestions) {
    const option = document.createElement('option');
    option.value = suggestion.value;
    option.label = `${suggestion.count} similar products`;
    datalist.append(option);
  }
}

function renderCatalogSuggestions(suggestions) {
  const similarProducts = suggestions?.similarProducts || [];
  const similarProductCount = suggestions?.similarProductCount || 0;
  const vendors = suggestions?.vendors || [];
  const categories = suggestions?.categories || [];
  const productTypes = suggestions?.productTypes || [];
  const templates = suggestions?.templates || [];
  const tags = suggestions?.tags || [];

  if (similarProductCount) {
    const examples = similarProducts.map(item => item.title).join('; ');
    catalogSuggestionSummary.textContent = `Suggestions based on ${similarProductCount} similar Shopify product${similarProductCount === 1 ? '' : 's'}${examples ? `: ${examples}` : '.'}`;
  } else {
    catalogSuggestionSummary.textContent = 'No similar products were found in your Shopify catalog. You can enter these fields manually.';
  }

  populateDatalist(vendorSuggestions, vendors);
  populateDatalist(productTypeSuggestions, productTypes);
  categoryInput.replaceChildren();
  const noCategory = document.createElement('option');
  noCategory.value = '';
  noCategory.textContent = categories.length ? 'No category' : 'No category suggestion';
  categoryInput.append(noCategory);
  for (const category of categories) {
    const option = document.createElement('option');
    option.value = category.id;
    option.textContent = `${category.fullName || category.name} (${category.count})`;
    categoryInput.append(option);
  }

  templateInput.replaceChildren();
  const defaultTemplate = templates.find(template => !template.value);
  const defaultTemplateOption = document.createElement('option');
  defaultTemplateOption.value = '';
  defaultTemplateOption.textContent = `Default product${defaultTemplate ? ` (${defaultTemplate.count})` : ''}`;
  templateInput.append(defaultTemplateOption);
  for (const template of templates.filter(item => item.value)) {
    const option = document.createElement('option');
    option.value = template.value;
    option.textContent = `${template.label} (${template.count})`;
    templateInput.append(option);
  }

  tagSuggestions.replaceChildren();
  for (const tag of tags) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tag-suggestion';
    button.textContent = `+ ${tag.value} (${tag.count})`;
    button.setAttribute('aria-label', `Add suggested tag ${tag.value}`);
    button.addEventListener('click', () => {
      const currentTags = tagsInput.value.split(',').map(value => value.trim()).filter(Boolean);
      if (!currentTags.some(value => value.toLocaleLowerCase() === tag.value.toLocaleLowerCase())) {
        currentTags.push(tag.value);
        tagsInput.value = currentTags.join(', ');
      }
    });
    tagSuggestions.append(button);
  }
}

function showPreview(nextProduct) {
  product = nextProduct;
  productImage.src = product.imagePreviewDataUrl;
  productImage.alt = product.title;
  titleInput.value = product.title;
  skuInput.value = product.sku;
  priceInput.value = product.price;
  descriptionInput.value = product.descriptionHtml;
  renderCatalogSuggestions(product.catalogSuggestions);
  vendorInput.value = product.vendor || '';
  categoryInput.value = product.categoryId || '';
  productTypeInput.value = product.productType || '';
  templateInput.value = product.templateSuffix || '';
  tagsInput.value = (product.tags || []).join(', ');
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
      vendor: vendorInput.value,
      categoryId: categoryInput.value,
      productType: productTypeInput.value,
      templateSuffix: templateInput.value,
      tags: tagsInput.value,
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
