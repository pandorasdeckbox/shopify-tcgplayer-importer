import crypto from 'node:crypto';
import pg from 'pg';

const { Pool } = pg;

const SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS shopify_sessions (
  shop TEXT PRIMARY KEY,
  access_token TEXT NOT NULL,
  scope TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  refresh_token TEXT NOT NULL,
  refresh_token_expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_states (
  state_hash TEXT PRIMARY KEY,
  shop TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS oauth_states_expiry_idx ON oauth_states (expires_at);
`;

const POSTGRES_SCHEMA = `
CREATE TABLE IF NOT EXISTS shopify_sessions (
  shop TEXT PRIMARY KEY,
  access_token TEXT NOT NULL,
  scope TEXT NOT NULL,
  expires_at BIGINT NOT NULL,
  refresh_token TEXT NOT NULL,
  refresh_token_expires_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_states (
  state_hash TEXT PRIMARY KEY,
  shop TEXT NOT NULL,
  expires_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS oauth_states_expiry_idx ON oauth_states (expires_at);
`;

function mapSession(row) {
  if (!row) return null;
  return {
    shop: row.shop,
    accessToken: row.access_token,
    scope: row.scope,
    expiresAt: Number(row.expires_at),
    refreshToken: row.refresh_token,
    refreshTokenExpiresAt: Number(row.refresh_token_expires_at),
    updatedAt: Number(row.updated_at),
  };
}

export class AppDatabase {
  constructor({ databaseUrl = '', sqlitePath = './tcgplayer-importer.sqlite', pool, sqlite } = {}) {
    this.databaseUrl = databaseUrl;
    this.sqlitePath = sqlitePath;
    this.pool = pool || null;
    this.sqlite = sqlite || null;
  }

  async init() {
    if (this.pool || this.sqlite) return this;

    if (/^postgres(?:ql)?:\/\//.test(this.databaseUrl)) {
      this.pool = new Pool({ connectionString: this.databaseUrl });
      await this.pool.query(POSTGRES_SCHEMA);
    } else {
      const { default: Database } = await import('better-sqlite3');
      this.sqlite = new Database(this.sqlitePath);
      this.sqlite.pragma('journal_mode = WAL');
      this.sqlite.exec(SQLITE_SCHEMA);
    }
    return this;
  }

  async saveOAuthState(shop, state, expiresAt) {
    const stateHash = crypto.createHash('sha256').update(state).digest('hex');
    if (this.pool) {
      await this.pool.query('DELETE FROM oauth_states WHERE expires_at <= $1', [Date.now()]);
      await this.pool.query(
        'INSERT INTO oauth_states (state_hash, shop, expires_at) VALUES ($1, $2, $3)',
        [stateHash, shop, expiresAt],
      );
    } else {
      this.sqlite.prepare('DELETE FROM oauth_states WHERE expires_at <= ?').run(Date.now());
      this.sqlite.prepare(
        'INSERT INTO oauth_states (state_hash, shop, expires_at) VALUES (?, ?, ?)',
      ).run(stateHash, shop, expiresAt);
    }
  }

  async consumeOAuthState(shop, state) {
    const stateHash = crypto.createHash('sha256').update(state).digest('hex');
    const now = Date.now();
    if (this.pool) {
      const result = await this.pool.query(
        'DELETE FROM oauth_states WHERE state_hash = $1 AND shop = $2 AND expires_at > $3 RETURNING state_hash',
        [stateHash, shop, now],
      );
      return result.rowCount === 1;
    }
    return this.sqlite.prepare(
      'DELETE FROM oauth_states WHERE state_hash = ? AND shop = ? AND expires_at > ?',
    ).run(stateHash, shop, now).changes === 1;
  }

  async storeShopifySession(session) {
    const values = [
      session.shop,
      session.accessToken,
      session.scope,
      session.expiresAt,
      session.refreshToken,
      session.refreshTokenExpiresAt,
      Date.now(),
    ];
    if (this.pool) {
      await this.pool.query(
        `INSERT INTO shopify_sessions
          (shop, access_token, scope, expires_at, refresh_token, refresh_token_expires_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (shop) DO UPDATE SET
           access_token = EXCLUDED.access_token,
           scope = EXCLUDED.scope,
           expires_at = EXCLUDED.expires_at,
           refresh_token = EXCLUDED.refresh_token,
           refresh_token_expires_at = EXCLUDED.refresh_token_expires_at,
           updated_at = EXCLUDED.updated_at`,
        values,
      );
      return;
    }
    this.sqlite.prepare(
      `INSERT INTO shopify_sessions
        (shop, access_token, scope, expires_at, refresh_token, refresh_token_expires_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (shop) DO UPDATE SET
         access_token = excluded.access_token,
         scope = excluded.scope,
         expires_at = excluded.expires_at,
         refresh_token = excluded.refresh_token,
         refresh_token_expires_at = excluded.refresh_token_expires_at,
         updated_at = excluded.updated_at`,
    ).run(...values);
  }

  async loadShopifySession(shop) {
    if (this.pool) {
      const result = await this.pool.query('SELECT * FROM shopify_sessions WHERE shop = $1', [shop]);
      return mapSession(result.rows[0]);
    }
    return mapSession(this.sqlite.prepare('SELECT * FROM shopify_sessions WHERE shop = ?').get(shop));
  }

  async rotateShopifySession(shop, expectedRefreshToken, session) {
    const values = [
      session.accessToken,
      session.scope,
      session.expiresAt,
      session.refreshToken,
      session.refreshTokenExpiresAt,
      Date.now(),
      shop,
      expectedRefreshToken,
    ];
    if (this.pool) {
      const result = await this.pool.query(
        `UPDATE shopify_sessions SET
           access_token = $1, scope = $2, expires_at = $3,
           refresh_token = $4, refresh_token_expires_at = $5, updated_at = $6
         WHERE shop = $7 AND refresh_token = $8`,
        values,
      );
      return result.rowCount === 1;
    }
    return this.sqlite.prepare(
      `UPDATE shopify_sessions SET
         access_token = ?, scope = ?, expires_at = ?,
         refresh_token = ?, refresh_token_expires_at = ?, updated_at = ?
       WHERE shop = ? AND refresh_token = ?`,
    ).run(...values).changes === 1;
  }

  async deleteShopifySession(shop) {
    if (this.pool) {
      await this.pool.query('DELETE FROM shopify_sessions WHERE shop = $1', [shop]);
      return;
    }
    this.sqlite.prepare('DELETE FROM shopify_sessions WHERE shop = ?').run(shop);
  }

  async close() {
    if (this.pool) await this.pool.end();
    if (this.sqlite) this.sqlite.close();
  }
}
