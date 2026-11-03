# TCGplayer Importer

Public, multi-store Shopify app scaffold for importing a product from a
TCGplayer product page. Start an import from the app's home page, or open a
Shopify product details page and use **More actions → Import from TCGplayer**.
Paste a product URL, review/edit the imported fields, and explicitly create a
separate Draft product.

The app imports the TCGplayer product name, description, Market Price, and
product image. The URL's numeric product ID is the default variant SKU. Market
Price is floored to whole USD dollars. Inventory is not changed. The image is
contained within 880 × 880 pixels on a 1000 × 1000 white canvas.

The source-page HTML can challenge automated clients, so the import pipeline
uses TCGplayer's product-details endpoint and product image CDN rather than
scraping the rendered page. These are currently the same public endpoints used
by the local TCGplayer repricer scripts; they aren't a guarantee of a stable
or supported TCGplayer API. If TCGplayer changes access or response formats,
the importer surfaces an error instead of creating a partially populated
product. Confirm your rights and TCGplayer's terms before distributing this
app or reusing its product content.

## Stack

- Node.js 22, Express, Shopify Admin GraphQL API
- Embedded app home with a TCGplayer URL import workflow
- Shopify Admin UI action extension at
  `admin.product-details.action.render` (the Product Details More actions menu)
- Shopify public OAuth with expiring offline tokens and refresh-token rotation
- PostgreSQL in production; SQLite for local development
- Railway-compatible web service

## Development setup

1. Use Node.js 22 and install dependencies with `npm ci`.
2. Create an app in Shopify Dev Dashboard under your Partner organization. In
   the distribution card, choose **Public distribution** if this app is meant
   for App Store review. Shopify says this choice cannot be changed later.
3. Configure the app's public URL, OAuth callback, `write_products` scope, and
   the Admin action extension in the Dev Dashboard / Shopify CLI configuration.
   The production app URL must not contain the word `Shopify`.
4. Copy `.env.example` to `.env` and set `SHOPIFY_API_KEY`,
   `SHOPIFY_API_SECRET`, `APP_URL`, and a local `SQLITE_PATH`. `APP_URL` is the
   public origin (no `/app` suffix); it must be reachable over HTTPS for
   Shopify OAuth and extension API calls.
5. Run `npm run dev` for the web service. Use a public HTTPS tunnel for local
   development and set the matching `APP_URL` and OAuth callback URL.
6. Run `npm run shopify:dev` to preview the app and extension on a development
   store. The app must be installed with `write_products`.

The OAuth callback is `${APP_URL}/auth/callback`. The product action calls the
same app origin using Shopify's signed OpenID Connect ID token; the backend
validates the token and refreshes the store's expiring offline access token
before calling Shopify.

## Tests and checks

```sh
npm test
npm run lint
npm run shopify:deploy
```

`npm run shopify:deploy` requires a linked Shopify CLI app and an authenticated
Partner account. No Shopify credentials or store access are included in this
repository.

## Production and App Store launch

Deploy this repository as a Railway web service with a PostgreSQL database.
Set `NODE_ENV=production`, `APP_URL`, `SHOPIFY_API_KEY`,
`SHOPIFY_API_SECRET`, and `DATABASE_URL`; Railway supplies `PORT`. Update
`client_id` in `shopify.app.toml` to the Shopify Dev Dashboard Client ID. The
app and callback URLs are configured for
`https://tcgpimporter.pandorasdeckbox.com`; keep these in sync with the Dev
Dashboard if the domain changes. Then run `npm run shopify:deploy`.

The app subscribes to `app/uninstalled` and Shopify's three mandatory privacy
compliance topics. It stores only the shop domain and OAuth tokens, not
customer records. Before App Store review, complete the Partner listing,
privacy policy, support/emergency contact information, automated checks, and
Shopify review submission. The app's use of TCGplayer product descriptions
and artwork should be disclosed and supported by appropriate permissions.
