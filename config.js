import dotenv from 'dotenv';

dotenv.config();

function required(name, env) {
  const value = env[name];
  return value && value.trim() ? value.trim() : null;
}

export function loadConfig(env = process.env) {
  const isProduction = env.NODE_ENV === 'production';
  const appUrl = (env.APP_URL || 'http://localhost:3000').replace(/\/+$/, '');
  const config = {
    nodeEnv: env.NODE_ENV || 'development',
    isProduction,
    port: Number(env.PORT || 3000),
    appUrl,
    shopifyApiKey: required('SHOPIFY_API_KEY', env),
    shopifyApiSecret: required('SHOPIFY_API_SECRET', env),
    shopifyApiVersion: env.SHOPIFY_API_VERSION || '2026-10',
    databaseUrl: required('DATABASE_URL', env),
    sqlitePath: env.SQLITE_PATH || './tcgplayer-importer.sqlite',
  };

  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(config.shopifyApiVersion)) {
    throw new Error('SHOPIFY_API_VERSION must use the YYYY-MM format');
  }
  if (isProduction) {
    const missing = [
      ['APP_URL', env.APP_URL],
      ['SHOPIFY_API_KEY', config.shopifyApiKey],
      ['SHOPIFY_API_SECRET', config.shopifyApiSecret],
      ['DATABASE_URL', config.databaseUrl],
    ].filter(([, value]) => !value).map(([name]) => name);
    if (missing.length) {
      throw new Error(`Missing required production configuration: ${missing.join(', ')}`);
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(config.appUrl);
    } catch {
      throw new Error('APP_URL must be a valid HTTPS URL in production');
    }
    if (parsedUrl.protocol !== 'https:') {
      throw new Error('APP_URL must use HTTPS in production');
    }
    if (!config.databaseUrl.startsWith('postgres://') && !config.databaseUrl.startsWith('postgresql://')) {
      throw new Error('DATABASE_URL must point to PostgreSQL in production');
    }
  }

  return config;
}

export const config = loadConfig();
