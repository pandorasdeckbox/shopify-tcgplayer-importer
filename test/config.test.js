import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../config.js';

test('loads local defaults without credentials', () => {
  const config = loadConfig({});
  assert.equal(config.nodeEnv, 'development');
  assert.equal(config.port, 3000);
  assert.equal(config.appUrl, 'http://localhost:3000');
  assert.equal(config.shopifyApiVersion, '2026-10');
  assert.equal(config.sqlitePath, './tcgplayer-importer.sqlite');
});

test('requires public app credentials, PostgreSQL, and HTTPS in production', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'production' }), /APP_URL, SHOPIFY_API_KEY/);
  assert.throws(() => loadConfig({
    NODE_ENV: 'production',
    APP_URL: 'http://app.example.com',
    SHOPIFY_API_KEY: 'client-id',
    SHOPIFY_API_SECRET: 'secret',
    DATABASE_URL: 'postgres://database',
  }), /APP_URL must use HTTPS/);
  assert.throws(() => loadConfig({
    NODE_ENV: 'production',
    APP_URL: 'https://app.example.com',
    SHOPIFY_API_KEY: 'client-id',
    SHOPIFY_API_SECRET: 'secret',
    DATABASE_URL: 'sqlite.db',
  }), /DATABASE_URL must point to PostgreSQL/);
});
