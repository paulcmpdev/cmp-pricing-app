import "server-only";

import { Pool } from "pg";
import {
  createPostgresPricingConfigRepository,
  type PricingConfigRepository,
} from "./postgres-repository";

let pool: Pool | undefined;
let poolUrl: string | undefined;

function configuredDatabaseUrl(): string | undefined {
  const url =
    process.env.CMP_DATABASE_URL?.trim() ||
    process.env.VENDOR_CATALOG_DATABASE_URL?.trim() ||
    undefined;
  return url || undefined;
}

function getPool(): Pool {
  const url = configuredDatabaseUrl();
  if (!url) throw new Error("No database URL configured for pricing config.");
  if (!pool || poolUrl !== url) {
    void pool?.end();
    pool = new Pool({
      connectionString: url,
      max: 2,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
    });
    poolUrl = url;
  }
  return pool;
}

export function getPricingConfigRepository(): PricingConfigRepository {
  return createPostgresPricingConfigRepository(getPool());
}

export function isPricingConfigDatabaseConfigured(): boolean {
  return !!configuredDatabaseUrl();
}
