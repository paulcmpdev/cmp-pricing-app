/**
 * Pricing config resolver.
 *
 * When CMP_PRICING_CONFIG_ENABLED=true: reads from PostgreSQL.
 *   - Reads: DB failure returns operational error (no silent fallback).
 *   - Missing active version: 503 (admin must seed config first).
 *   - Stored JSONB is validated against schema on every read.
 *
 * When disabled: reads return verified static baseline.
 *   Writes are not available.
 */
import "server-only";
import { isPricingConfigEnabled } from "./gate";
import { getBaselineDtfMatrix, getBaselineAdditionalPrints } from "./baseline";
import {
  DtfMatrixConfigSchema,
  AdditionalPrintsConfigSchema,
} from "./schemas";
import type { ConfigType, DtfMatrixConfig, AdditionalPrintsConfig, PricingConfigVersion } from "./schemas";

export type ConfigReadFailureReason =
  | "not_configured"
  | "database_unavailable"
  | "no_active_version"
  | "validation_failed";

export type ConfigReadResult =
  | { ok: true; source: "database"; version: PricingConfigVersion }
  | { ok: true; source: "baseline"; data: DtfMatrixConfig | AdditionalPrintsConfig }
  | { ok: false; reason: ConfigReadFailureReason; error: string };

function validateConfigData(
  configType: ConfigType,
  data: unknown
):
  | { valid: true; data: DtfMatrixConfig | AdditionalPrintsConfig }
  | { valid: false; error: string } {
  const schema =
    configType === "dtf_matrix"
      ? DtfMatrixConfigSchema
      : AdditionalPrintsConfigSchema;
  const result = schema.safeParse(data);
  if (!result.success) {
    return {
      valid: false,
      error: `Stored ${configType} config failed validation: ${result.error.issues.map((i) => i.message).join("; ")}`,
    };
  }
  return { valid: true, data: result.data };
}

export async function resolveActiveConfig(
  configType: ConfigType
): Promise<ConfigReadResult> {
  if (!isPricingConfigEnabled()) {
    const data =
      configType === "dtf_matrix"
        ? getBaselineDtfMatrix()
        : getBaselineAdditionalPrints();
    return { ok: true, source: "baseline", data };
  }

  try {
    const { getPricingConfigRepository, isPricingConfigDatabaseConfigured } =
      await import("./repository");

    if (!isPricingConfigDatabaseConfigured()) {
      return {
        ok: false,
        reason: "not_configured",
        error: "Pricing config persistence is enabled but no database is configured.",
      };
    }

    const repo = getPricingConfigRepository();
    const version = await repo.getActiveVersion(configType);

    if (!version) {
      return {
        ok: false,
        reason: "no_active_version",
        error: `No active ${configType} configuration found. An admin must save and activate a configuration.`,
      };
    }

    // Validate stored JSONB data against schema. Use the parsed/normalized
    // result rather than the raw JSONB so defaulted fields (e.g.
    // operatorOperatingCost added after older rows were written) are
    // present on every read, not just newly-saved versions.
    const validation = validateConfigData(configType, version.data);
    if (!validation.valid) {
      return { ok: false, reason: "validation_failed", error: validation.error };
    }

    return {
      ok: true,
      source: "database",
      version: { ...version, data: validation.data },
    };
  } catch {
    return {
      ok: false,
      reason: "database_unavailable",
      error: "Pricing configuration database is unavailable.",
    };
  }
}
