import type { Pool, PoolClient } from "pg";
import { DtfMatrixConfigSchema, AdditionalPrintsConfigSchema } from "./schemas";
import type {
  ConfigType,
  DtfMatrixConfig,
  AdditionalPrintsConfig,
  PricingConfigVersion,
} from "./schemas";

export type SaveResult =
  | { ok: true; version: PricingConfigVersion }
  | { ok: false; reason: "conflict"; message: string };

export type ActivateResult =
  | { ok: true; version: PricingConfigVersion }
  | {
      ok: false;
      reason: "not_found" | "conflict" | "already_active" | "invalid_snapshot";
      message: string;
    };

export interface PricingConfigRepository {
  getActiveVersion(configType: ConfigType): Promise<PricingConfigVersion | null>;
  getVersion(versionId: string): Promise<PricingConfigVersion | null>;
  listVersions(configType: ConfigType, limit?: number): Promise<PricingConfigVersion[]>;
  saveAndActivate(
    configType: ConfigType,
    data: DtfMatrixConfig | AdditionalPrintsConfig,
    actorEmail: string,
    expectedVersionId: string | null
  ): Promise<SaveResult>;
  activateVersion(
    configType: ConfigType,
    versionId: string,
    expectedCurrentVersionId: string | null,
    actorEmail: string
  ): Promise<ActivateResult>;
}

// Advisory lock key for pricing config mutations
const PRICING_CONFIG_LOCK_KEY = 839274020;

function rowToVersion(row: Record<string, unknown>): PricingConfigVersion {
  return {
    id: row.id as string,
    configType: row.config_type as ConfigType,
    data: row.data as DtfMatrixConfig | AdditionalPrintsConfig,
    status: row.status as "active" | "superseded",
    createdBy: row.created_by as string,
    createdAt: (row.created_at as Date).toISOString(),
    activatedAt: row.activated_at
      ? (row.activated_at as Date).toISOString()
      : null,
    supersededAt: row.superseded_at
      ? (row.superseded_at as Date).toISOString()
      : null,
  };
}

function validateAgainstCurrentSchema(
  configType: ConfigType,
  data: unknown
):
  | { valid: true; data: DtfMatrixConfig | AdditionalPrintsConfig }
  | { valid: false; message: string } {
  const schema =
    configType === "dtf_matrix" ? DtfMatrixConfigSchema : AdditionalPrintsConfigSchema;
  const result = schema.safeParse(data);
  if (!result.success) {
    return {
      valid: false,
      message: `Historical version no longer conforms to the current ${configType} schema: ${result.error.issues.map((i) => i.message).join("; ")}`,
    };
  }
  return { valid: true, data: result.data };
}

async function withTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export function createPostgresPricingConfigRepository(
  pool: Pool
): PricingConfigRepository {
  return {
    async getActiveVersion(configType) {
      const result = await pool.query(
        `SELECT v.* FROM pricing_config_versions v
         JOIN pricing_config_active a ON a.version_id = v.id
         WHERE a.config_type = $1 AND v.status = 'active'`,
        [configType]
      );
      return result.rows.length > 0 ? rowToVersion(result.rows[0]) : null;
    },

    async getVersion(versionId) {
      const result = await pool.query(
        "SELECT * FROM pricing_config_versions WHERE id = $1",
        [versionId]
      );
      return result.rows.length > 0 ? rowToVersion(result.rows[0]) : null;
    },

    async listVersions(configType, limit = 20) {
      const result = await pool.query(
        `SELECT * FROM pricing_config_versions
         WHERE config_type = $1
         ORDER BY created_at DESC
         LIMIT $2`,
        [configType, limit]
      );
      return result.rows.map(rowToVersion);
    },

    async saveAndActivate(configType, data, actorEmail, expectedVersionId) {
      return withTransaction(pool, async (client) => {
        await client.query("SELECT pg_advisory_xact_lock($1)", [
          PRICING_CONFIG_LOCK_KEY,
        ]);

        // Optimistic concurrency: check current active version matches expected
        const currentActive = await client.query(
          "SELECT version_id FROM pricing_config_active WHERE config_type = $1 FOR UPDATE",
          [configType]
        );

        const currentVersionId =
          currentActive.rows.length > 0
            ? (currentActive.rows[0].version_id as string)
            : null;

        if (currentVersionId !== expectedVersionId) {
          return {
            ok: false as const,
            reason: "conflict" as const,
            message: `Expected active version ${expectedVersionId ?? "(none)"}, found ${currentVersionId ?? "(none)"}. Another admin may have saved changes.`,
          };
        }

        // Supersede previous active version
        if (currentVersionId) {
          await client.query(
            `UPDATE pricing_config_versions
             SET status = 'superseded', superseded_at = CURRENT_TIMESTAMP
             WHERE id = $1 AND status = 'active'`,
            [currentVersionId]
          );
        }

        // Insert new version as active
        const insertResult = await client.query(
          `INSERT INTO pricing_config_versions
           (config_type, data, status, created_by, activated_at)
           VALUES ($1, $2, 'active', $3, CURRENT_TIMESTAMP)
           RETURNING *`,
          [configType, JSON.stringify(data), actorEmail]
        );
        const newVersion = rowToVersion(insertResult.rows[0]);

        // Upsert active pointer
        await client.query(
          `INSERT INTO pricing_config_active (config_type, version_id, activated_at, activated_by)
           VALUES ($1, $2, CURRENT_TIMESTAMP, $3)
           ON CONFLICT (config_type) DO UPDATE
           SET version_id = $2, activated_at = CURRENT_TIMESTAMP, activated_by = $3`,
          [configType, newVersion.id, actorEmail]
        );

        // Audit event
        await client.query(
          `INSERT INTO pricing_config_events
           (config_type, action, actor_email, prior_version_id, new_version_id)
           VALUES ($1, 'activated', $2, $3, $4)`,
          [configType, actorEmail, currentVersionId, newVersion.id]
        );

        return { ok: true as const, version: newVersion };
      });
    },

    async activateVersion(configType, versionId, expectedCurrentVersionId, actorEmail) {
      return withTransaction(pool, async (client) => {
        await client.query("SELECT pg_advisory_xact_lock($1)", [
          PRICING_CONFIG_LOCK_KEY,
        ]);

        // Verify target version exists and belongs to this config type
        const target = await client.query(
          "SELECT * FROM pricing_config_versions WHERE id = $1 AND config_type = $2",
          [versionId, configType]
        );
        if (target.rows.length === 0) {
          return {
            ok: false as const,
            reason: "not_found" as const,
            message: "Version not found.",
          };
        }

        if (target.rows[0].status === "active") {
          return {
            ok: false as const,
            reason: "already_active" as const,
            message: "Version is already active.",
          };
        }

        // Optimistic concurrency
        const currentActive = await client.query(
          "SELECT version_id FROM pricing_config_active WHERE config_type = $1 FOR UPDATE",
          [configType]
        );
        const currentVersionId =
          currentActive.rows.length > 0
            ? (currentActive.rows[0].version_id as string)
            : null;

        if (currentVersionId !== expectedCurrentVersionId) {
          return {
            ok: false as const,
            reason: "conflict" as const,
            message: `Expected active version ${expectedCurrentVersionId ?? "(none)"}, found ${currentVersionId ?? "(none)"}.`,
          };
        }

        // Re-validate the historical snapshot against the CURRENT schema before
        // promoting it — the schema may have evolved since this version was saved.
        const validation = validateAgainstCurrentSchema(configType, target.rows[0].data);
        if (!validation.valid) {
          return {
            ok: false as const,
            reason: "invalid_snapshot" as const,
            message: validation.message,
          };
        }

        // Supersede current active version (historical snapshot stays immutable)
        if (currentVersionId) {
          await client.query(
            `UPDATE pricing_config_versions
             SET status = 'superseded', superseded_at = CURRENT_TIMESTAMP
             WHERE id = $1 AND status = 'active'`,
            [currentVersionId]
          );
        }

        // Create a NEW immutable version copied from the historical target
        // (the original snapshot remains untouched as superseded). Uses the
        // parsed/normalized data from validateAgainstCurrentSchema rather
        // than the raw JSONB so defaulted fields (e.g. operatorOperatingCost
        // on older rows) are copied forward into the new active version.
        const insertResult = await client.query(
          `INSERT INTO pricing_config_versions
           (config_type, data, status, created_by, activated_at)
           VALUES ($1, $2, 'active', $3, CURRENT_TIMESTAMP)
           RETURNING *`,
          [configType, JSON.stringify(validation.data), actorEmail]
        );
        const newVersion = rowToVersion(insertResult.rows[0]);

        // Upsert active pointer to the new version
        await client.query(
          `INSERT INTO pricing_config_active (config_type, version_id, activated_at, activated_by)
           VALUES ($1, $2, CURRENT_TIMESTAMP, $3)
           ON CONFLICT (config_type) DO UPDATE
           SET version_id = $2, activated_at = CURRENT_TIMESTAMP, activated_by = $3`,
          [configType, newVersion.id, actorEmail]
        );

        // Audit event distinctly preserves the requested historical source
        // version (source_version_id), the version it superseded
        // (prior_version_id), and the freshly created copy (new_version_id).
        await client.query(
          `INSERT INTO pricing_config_events
           (config_type, action, actor_email, prior_version_id, new_version_id, source_version_id)
           VALUES ($1, 'rollback', $2, $3, $4, $5)`,
          [configType, actorEmail, currentVersionId, newVersion.id, versionId]
        );

        return { ok: true as const, version: newVersion };
      });
    },
  };
}
