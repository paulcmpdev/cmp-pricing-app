import { z } from "zod";

// ── DTF Matrix Config ──────────────────────────────────────────────

export const DtfLaneSchema = z
  .object({
    key: z.string().min(1).max(20),
    label: z.string().min(1).max(50),
    margin: z.number().min(0).lt(1),
    active: z.boolean(),
  })
  .strict();

export type DtfLane = z.infer<typeof DtfLaneSchema>;

export const DtfTierSchema = z
  .object({
    tier: z.string().min(1).max(30),
    minQty: z.number().int().min(1),
    maxQty: z.number().int().min(1).nullable(),
    // Keyed by lane key (max(20), matching DtfLaneSchema.key) — bounded below
    // to at most one price per declared lane so the record can't be padded
    // with arbitrary unknown keys.
    prices: z.record(z.string().min(1).max(20), z.number().min(0)),
  })
  .strict();

export type DtfTier = z.infer<typeof DtfTierSchema>;

export const DtfMatrixConfigSchema = z
  .object({
    lanes: z.array(DtfLaneSchema).min(1).max(20),
    tiers: z.array(DtfTierSchema).min(1).max(50),
  })
  .strict()
  .superRefine((data, ctx) => {
    // Unique lane keys
    const laneKeys = new Set<string>();
    for (const lane of data.lanes) {
      if (laneKeys.has(lane.key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate lane key: ${lane.key}`,
          path: ["lanes"],
        });
      }
      laneKeys.add(lane.key);
    }

    // At least one active lane
    const activeLaneKeys = new Set(
      data.lanes.filter((l) => l.active).map((l) => l.key)
    );
    if (activeLaneKeys.size === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "At least one lane must be active",
        path: ["lanes"],
      });
    }

    // Validate tier structure
    for (let i = 0; i < data.tiers.length; i++) {
      const tier = data.tiers[i];
      const isLast = i === data.tiers.length - 1;

      // Only the final tier may be open-ended (maxQty: null)
      if (tier.maxQty === null && !isLast) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Only the final tier may be open-ended; tier "${tier.tier}" is not last`,
          path: ["tiers", i],
        });
      }

      if (tier.maxQty !== null && tier.maxQty < tier.minQty) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Tier "${tier.tier}": maxQty (${tier.maxQty}) < minQty (${tier.minQty})`,
          path: ["tiers", i],
        });
      }

      // Every tier must have prices for all active lanes
      for (const key of activeLaneKeys) {
        if (tier.prices[key] == null) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Tier "${tier.tier}" missing price for lane "${key}"`,
            path: ["tiers", i, "prices"],
          });
        }
      }

      // Prices may only reference declared lanes — this bounds the size of
      // the prices record to at most lanes.length (<=20) entries, so it
      // can't be padded with arbitrary unknown keys.
      for (const key of Object.keys(tier.prices)) {
        if (!laneKeys.has(key)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Tier "${tier.tier}" has a price for undeclared lane "${key}"`,
            path: ["tiers", i, "prices"],
          });
        }
      }

      // Check contiguity: next tier minQty = this tier maxQty + 1
      if (i < data.tiers.length - 1) {
        if (tier.maxQty === null) {
          // Already handled above — open-ended non-final tier
        } else {
          const next = data.tiers[i + 1];
          if (next.minQty !== tier.maxQty + 1) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `Gap between tier "${tier.tier}" (max ${tier.maxQty}) and "${next.tier}" (min ${next.minQty})`,
              path: ["tiers"],
            });
          }
        }
      }
    }

    // First tier must start at 1
    if (data.tiers.length > 0 && data.tiers[0].minQty !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `First tier must start at quantity 1, got ${data.tiers[0].minQty}`,
        path: ["tiers", 0],
      });
    }

    // Final tier should be open-ended
    if (data.tiers.length > 0) {
      const last = data.tiers[data.tiers.length - 1];
      if (last.maxQty !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Final tier "${last.tier}" must be open-ended (maxQty: null)`,
          path: ["tiers", data.tiers.length - 1],
        });
      }
    }
  });

export type DtfMatrixConfig = z.infer<typeof DtfMatrixConfigSchema>;

// ── Additional Prints Config ───────────────────────────────────────

export const SERVICE_TYPES = ["service", "package"] as const;
export type ServiceType = (typeof SERVICE_TYPES)[number];

export const ServiceCompositionSchema = z
  .object({
    sizeKey: z.string().min(1).max(60),
    quantityPerShirt: z.number().int().min(1),
  })
  .strict();

export type ServiceComposition = z.infer<typeof ServiceCompositionSchema>;

export const AdditionalPrintServiceSchema = z
  .object({
    key: z.string().min(1).max(60),
    name: z.string().min(1).max(100),
    description: z.string().max(500),
    type: z.enum(SERVICE_TYPES),
    geometryKey: z.string().min(1).max(60).nullable(),
    composition: z.array(ServiceCompositionSchema).min(1).max(20),
    cogs: z.number().min(0),
    operatorOperatingCost: z.number().min(0).default(0),
    enginePrice: z.number().int().min(0),
    policyFloor: z.number().min(0),
    manualOverride: z.number().min(0).nullable(),
    effectivePrice: z.number().min(0),
    grossMargin: z.number(),
    status: z.string().min(1).max(100),
    operatorMinPerShirt: z.number().min(0),
    designerMinPerOrder: z.number().min(0),
    active: z.boolean(),
    sortOrder: z.number().int().min(0),
  })
  .strict();

export type AdditionalPrintService = z.infer<typeof AdditionalPrintServiceSchema>;

export const REQUIRED_COLUMN_KEYS = ["name", "effectivePrice"] as const;
export const OPTIONAL_COLUMN_KEYS = [
  "description",
  "type",
  "geometryKey",
  "cogs",
  "operatorOperatingCost",
  "enginePrice",
  "policyFloor",
  "manualOverride",
  "grossMargin",
  "status",
  "operatorMinPerShirt",
  "designerMinPerOrder",
] as const;

export const ALL_COLUMN_KEYS = [
  ...REQUIRED_COLUMN_KEYS,
  ...OPTIONAL_COLUMN_KEYS,
] as const;

export type ColumnKey = (typeof ALL_COLUMN_KEYS)[number];

export const ColumnKeySchema = z.enum(
  ALL_COLUMN_KEYS as unknown as [string, ...string[]]
);

export const AdditionalPrintsColumnSchema = z
  .object({
    key: ColumnKeySchema,
    label: z.string().min(1).max(60),
    required: z.boolean(),
    visible: z.boolean(),
    order: z.number().int().min(0),
  })
  .strict();

export type AdditionalPrintsColumn = z.infer<typeof AdditionalPrintsColumnSchema>;

export const AdditionalPrintsConfigSchema = z
  .object({
    services: z.array(AdditionalPrintServiceSchema).min(1).max(50),
    columns: z.array(AdditionalPrintsColumnSchema).min(1).max(30),
    minimumBillableQuantity: z.number().int().min(1),
  })
  .strict()
  .superRefine((data, ctx) => {
    // Unique service keys
    const keys = new Set<string>();
    for (const svc of data.services) {
      if (keys.has(svc.key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate service key: ${svc.key}`,
          path: ["services"],
        });
      }
      keys.add(svc.key);
    }

    // Required columns must be present and visible
    for (const reqKey of REQUIRED_COLUMN_KEYS) {
      const col = data.columns.find((c) => c.key === reqKey);
      if (!col) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Required column "${reqKey}" is missing`,
          path: ["columns"],
        });
      } else if (!col.visible) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Required column "${reqKey}" cannot be hidden`,
          path: ["columns"],
        });
      }
    }

    // Unique column keys
    const colKeys = new Set<string>();
    for (const col of data.columns) {
      if (colKeys.has(col.key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate column key: ${col.key}`,
          path: ["columns"],
        });
      }
      colKeys.add(col.key);
    }

    // sortOrder must be exactly the contiguous set {0, 1, ..., n-1}, each
    // used once — this is what lets clients render services in a stable,
    // gap-free order without renumbering server-side.
    const sortOrders = data.services.map((s) => s.sortOrder).sort((a, b) => a - b);
    const isContiguous = sortOrders.every((value, index) => value === index);
    if (!isContiguous) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Service sortOrder values must be exactly contiguous and unique from 0 to ${data.services.length - 1}, got [${sortOrders.join(", ")}]`,
        path: ["services"],
      });
    }
  });

export type AdditionalPrintsConfig = z.infer<typeof AdditionalPrintsConfigSchema>;

// ── Config Types ───────────────────────────────────────────────────

export const CONFIG_TYPES = ["dtf_matrix", "additional_prints"] as const;
export type ConfigType = (typeof CONFIG_TYPES)[number];

export const PricingConfigVersionSchema = z
  .object({
    id: z.string().uuid(),
    configType: z.enum(CONFIG_TYPES),
    data: z.union([DtfMatrixConfigSchema, AdditionalPrintsConfigSchema]),
    status: z.enum(["active", "superseded"]),
    createdBy: z.string(),
    createdAt: z.string(),
    activatedAt: z.string().nullable(),
    supersededAt: z.string().nullable(),
  })
  .strict();

export type PricingConfigVersion = z.infer<typeof PricingConfigVersionSchema>;

// ── Save Request ───────────────────────────────────────────────────

export const SaveDtfMatrixRequestSchema = z
  .object({
    configType: z.literal("dtf_matrix"),
    data: DtfMatrixConfigSchema,
    expectedVersion: z.string().uuid().nullable(),
  })
  .strict();

export const SaveAdditionalPrintsRequestSchema = z
  .object({
    configType: z.literal("additional_prints"),
    data: AdditionalPrintsConfigSchema,
    expectedVersion: z.string().uuid().nullable(),
  })
  .strict();

export const SavePricingConfigRequestSchema = z.discriminatedUnion(
  "configType",
  [SaveDtfMatrixRequestSchema, SaveAdditionalPrintsRequestSchema]
);

export type SavePricingConfigRequest = z.infer<typeof SavePricingConfigRequestSchema>;

// ── Activate Request ───────────────────────────────────────────────

export const ActivatePricingConfigRequestSchema = z
  .object({
    configType: z.enum(CONFIG_TYPES),
    versionId: z.string().uuid(),
    expectedCurrentVersionId: z.string().uuid().nullable(),
  })
  .strict();

export type ActivatePricingConfigRequest = z.infer<typeof ActivatePricingConfigRequestSchema>;
