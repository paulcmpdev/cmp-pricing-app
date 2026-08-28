import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("next-auth/jwt", () => ({
  getToken: vi.fn(),
}));

vi.mock("@/lib/server/pricing-config/repository", () => ({
  getPricingConfigRepository: vi.fn(),
  isPricingConfigDatabaseConfigured: vi.fn(),
}));

import { getToken } from "next-auth/jwt";
import {
  getPricingConfigRepository,
  isPricingConfigDatabaseConfigured,
} from "@/lib/server/pricing-config/repository";
import { GET, PUT, MAX_PRICING_CONFIG_BODY_BYTES } from "../route";

const mockGetToken = vi.mocked(getToken);
const mockGetRepo = vi.mocked(getPricingConfigRepository);
const mockDbConfigured = vi.mocked(isPricingConfigDatabaseConfigured);
const env = process.env as Record<string, string | undefined>;

const VALID_DTF_MATRIX = {
  lanes: [{ key: "T1", label: "T1", margin: 0.5, active: true }],
  tiers: [{ tier: "1+", minQty: 1, maxQty: null, prices: { T1: 5 } }],
};

const SAMPLE_VERSION = {
  id: "11111111-1111-1111-1111-111111111111",
  configType: "dtf_matrix" as const,
  data: VALID_DTF_MATRIX,
  status: "active" as const,
  createdBy: "admin@cmpsportswear.com",
  createdAt: "2026-01-01T00:00:00.000Z",
  activatedAt: "2026-01-01T00:00:00.000Z",
  supersededAt: null,
};

const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "NODE_ENV",
  "VERCEL_ENV",
  "CMP_AUTH_ENABLED",
  "CMP_ENABLE_PRICING_PREVIEW",
  "CMP_PRICING_CONFIG_ENABLED",
  "CMP_DATABASE_URL",
  "VENDOR_CATALOG_DATABASE_URL",
];

function request(url: string, init?: RequestInit) {
  return new NextRequest(new Request(url, init));
}

const BASE_URL = "http://localhost/api/admin/pricing/config";

function putRequest(body: unknown, headers?: Record<string, string>) {
  return request(BASE_URL, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Origin: "http://localhost",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = env[key];
  }
  env.NODE_ENV = "test";
  delete env.VERCEL_ENV;
  env.CMP_AUTH_ENABLED = "true";
  env.CMP_ENABLE_PRICING_PREVIEW = "true";
  env.CMP_PRICING_CONFIG_ENABLED = "false";
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  vi.resetAllMocks();
});

describe("GET /api/admin/pricing/config", () => {
  it("allows the Preview-only baseline GET when auth is disabled and persistence is disabled", async () => {
    env.CMP_AUTH_ENABLED = "false";
    env.CMP_PRICING_CONFIG_ENABLED = "false";
    const res = await GET(request(`${BASE_URL}?type=dtf_matrix`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe("baseline");
    expect(body.persistenceEnabled).toBe(false);
    // Never reaches the repository — this is the static baseline, not a database read.
    expect(mockGetRepo).not.toHaveBeenCalled();
  });

  it("rejects the database-backed GET when auth is disabled and persistence is enabled", async () => {
    env.CMP_AUTH_ENABLED = "false";
    env.CMP_PRICING_CONFIG_ENABLED = "true";
    const res = await GET(request(`${BASE_URL}?type=dtf_matrix`));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain("Authentication must be enabled");
    // Never reaches the token check or the repository.
    expect(mockGetToken).not.toHaveBeenCalled();
    expect(mockGetRepo).not.toHaveBeenCalled();
  });

  it("returns 404 for the Preview-only baseline GET when the pricing-preview flag is off", async () => {
    env.CMP_AUTH_ENABLED = "false";
    env.CMP_PRICING_CONFIG_ENABLED = "false";
    env.CMP_ENABLE_PRICING_PREVIEW = "false";
    const res = await GET(request(`${BASE_URL}?type=dtf_matrix`));
    expect(res.status).toBe(404);
  });

  it("returns 401 for unauthenticated request", async () => {
    mockGetToken.mockResolvedValue(null);
    const res = await GET(request(`${BASE_URL}?type=dtf_matrix`));
    expect(res.status).toBe(401);
  });

  it("returns 403 for non-admin user", async () => {
    mockGetToken.mockResolvedValue({ email: "rep@cmpsportswear.com", role: "sales_rep" } as never);
    const res = await GET(request(`${BASE_URL}?type=dtf_matrix`));
    expect(res.status).toBe(403);
  });

  it("returns 400 for missing type parameter", async () => {
    mockGetToken.mockResolvedValue({ email: "admin@cmpsportswear.com", role: "admin" } as never);
    const res = await GET(request(BASE_URL));
    expect(res.status).toBe(400);
  });

  it("returns baseline data when persistence disabled", async () => {
    mockGetToken.mockResolvedValue({ email: "admin@cmpsportswear.com", role: "admin" } as never);
    const res = await GET(request(`${BASE_URL}?type=dtf_matrix`));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.source).toBe("baseline");
    expect(data.persistenceEnabled).toBe(false);
    expect(data.data.lanes).toBeDefined();
    expect(data.data.tiers).toBeDefined();
  });

  it("returns additional_prints baseline", async () => {
    mockGetToken.mockResolvedValue({ email: "admin@cmpsportswear.com", role: "admin" } as never);
    const res = await GET(request(`${BASE_URL}?type=additional_prints`));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.source).toBe("baseline");
    expect(data.data.services).toBeDefined();
    expect(data.data.minimumBillableQuantity).toBe(12);
  });

  it("returns database-sourced version metadata without leaking internal fields", async () => {
    env.CMP_PRICING_CONFIG_ENABLED = "true";
    env.CMP_DATABASE_URL = "postgres://user:pass@localhost:5432/db";
    mockGetToken.mockResolvedValue({ email: "admin@cmpsportswear.com", role: "admin" } as never);
    mockDbConfigured.mockReturnValue(true);
    mockGetRepo.mockReturnValue({
      getActiveVersion: vi.fn().mockResolvedValue(SAMPLE_VERSION),
      getVersion: vi.fn(),
      listVersions: vi.fn(),
      saveAndActivate: vi.fn(),
      activateVersion: vi.fn(),
    } as never);

    const res = await GET(request(`${BASE_URL}?type=dtf_matrix`));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.source).toBe("database");
    expect(data.persistenceEnabled).toBe(true);
    expect(data.version).toEqual({
      id: SAMPLE_VERSION.id,
      status: SAMPLE_VERSION.status,
      createdBy: SAMPLE_VERSION.createdBy,
      createdAt: SAMPLE_VERSION.createdAt,
      activatedAt: SAMPLE_VERSION.activatedAt,
    });
    expect(data.data).toEqual(VALID_DTF_MATRIX);
    // The version envelope must never leak beyond the whitelisted metadata fields.
    expect(Object.keys(data.version).sort()).toEqual(
      ["activatedAt", "createdAt", "createdBy", "id", "status"].sort()
    );
  });

  it("returns 503 when the database is unavailable", async () => {
    env.CMP_PRICING_CONFIG_ENABLED = "true";
    env.CMP_DATABASE_URL = "postgres://user:pass@localhost:5432/db";
    mockGetToken.mockResolvedValue({ email: "admin@cmpsportswear.com", role: "admin" } as never);
    mockDbConfigured.mockReturnValue(true);
    mockGetRepo.mockReturnValue({
      getActiveVersion: vi.fn().mockRejectedValue(new Error("connection refused")),
      getVersion: vi.fn(),
      listVersions: vi.fn(),
      saveAndActivate: vi.fn(),
      activateVersion: vi.fn(),
    } as never);

    const res = await GET(request(`${BASE_URL}?type=dtf_matrix`));
    expect(res.status).toBe(503);
  });

  it("serves baseline defaults for admin bootstrap when the DB is configured but has no active version yet", async () => {
    env.CMP_PRICING_CONFIG_ENABLED = "true";
    env.CMP_DATABASE_URL = "postgres://user:pass@localhost:5432/db";
    mockGetToken.mockResolvedValue({ email: "admin@cmpsportswear.com", role: "admin" } as never);
    mockDbConfigured.mockReturnValue(true);
    mockGetRepo.mockReturnValue({
      getActiveVersion: vi.fn().mockResolvedValue(null),
      getVersion: vi.fn(),
      listVersions: vi.fn(),
      saveAndActivate: vi.fn(),
      activateVersion: vi.fn(),
    } as never);

    const res = await GET(request(`${BASE_URL}?type=dtf_matrix`));
    // Admin-only bootstrap affordance: 200 with baseline data to edit and
    // save, not the fail-closed 503 that quote/read routes return.
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.source).toBe("baseline");
    expect(data.persistenceEnabled).toBe(true);
    expect(data.bootstrapRequired).toBe(true);
    expect(data.version).toBeNull();
    expect(data.data.lanes).toBeDefined();
    expect(data.data.tiers).toBeDefined();
  });
});

describe("PUT /api/admin/pricing/config", () => {
  it("returns 403 when auth is disabled", async () => {
    env.CMP_AUTH_ENABLED = "false";
    const res = await PUT(putRequest({ configType: "dtf_matrix", data: {}, expectedVersion: null }));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain("Authentication must be enabled");
  });

  it("returns 401 for unauthenticated request", async () => {
    mockGetToken.mockResolvedValue(null);
    const res = await PUT(putRequest({ configType: "dtf_matrix", data: {}, expectedVersion: null }));
    expect(res.status).toBe(401);
  });

  it("returns 403 for non-admin user", async () => {
    mockGetToken.mockResolvedValue({ email: "rep@cmpsportswear.com", role: "sales_rep" } as never);
    const res = await PUT(putRequest({ configType: "dtf_matrix", data: {}, expectedVersion: null }));
    expect(res.status).toBe(403);
  });

  it("returns 404 when persistence is disabled", async () => {
    env.CMP_PRICING_CONFIG_ENABLED = "false";
    mockGetToken.mockResolvedValue({ email: "admin@cmpsportswear.com", role: "admin" } as never);
    const res = await PUT(putRequest({ configType: "dtf_matrix", data: {}, expectedVersion: null }));
    expect(res.status).toBe(404);
  });

  it("returns 415 for wrong content type", async () => {
    env.CMP_PRICING_CONFIG_ENABLED = "true";
    mockGetToken.mockResolvedValue({ email: "admin@cmpsportswear.com", role: "admin" } as never);
    const res = await PUT(
      request(BASE_URL, {
        method: "PUT",
        headers: {
          "Content-Type": "text/plain",
          Origin: "http://localhost",
        },
        body: "not json",
      })
    );
    expect(res.status).toBe(415);
  });

  it("returns 403 for cross-origin request", async () => {
    env.CMP_PRICING_CONFIG_ENABLED = "true";
    mockGetToken.mockResolvedValue({ email: "admin@cmpsportswear.com", role: "admin" } as never);
    const res = await PUT(
      request(BASE_URL, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://evil.com",
        },
        body: JSON.stringify({ configType: "dtf_matrix", data: {}, expectedVersion: null }),
      })
    );
    expect(res.status).toBe(403);
  });

  it("returns 403 for missing origin", async () => {
    env.CMP_PRICING_CONFIG_ENABLED = "true";
    mockGetToken.mockResolvedValue({ email: "admin@cmpsportswear.com", role: "admin" } as never);
    const res = await PUT(
      request(BASE_URL, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ configType: "dtf_matrix", data: {}, expectedVersion: null }),
      })
    );
    expect(res.status).toBe(403);
  });

  it("returns 413 for oversized declared body", async () => {
    env.CMP_PRICING_CONFIG_ENABLED = "true";
    mockGetToken.mockResolvedValue({ email: "admin@cmpsportswear.com", role: "admin" } as never);
    const res = await PUT(
      request(BASE_URL, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(MAX_PRICING_CONFIG_BODY_BYTES + 1),
          Origin: "http://localhost",
        },
        body: JSON.stringify({}),
      })
    );
    expect(res.status).toBe(413);
  });

  it("returns 413 for a truly oversized streamed body without a Content-Length header", async () => {
    env.CMP_PRICING_CONFIG_ENABLED = "true";
    mockGetToken.mockResolvedValue({ email: "admin@cmpsportswear.com", role: "admin" } as never);
    const hugeBody = JSON.stringify({
      configType: "additional_prints",
      data: {},
      expectedVersion: null,
      _pad: "p".repeat(MAX_PRICING_CONFIG_BODY_BYTES + 1),
    });
    const res = await PUT(
      request(BASE_URL, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost",
          // No Content-Length: exercises the true streaming byte-count path,
          // not the declared-length shortcut.
        },
        body: hugeBody,
      })
    );
    expect(res.status).toBe(413);
  });

  it("accepts and saves a schema-valid Additional Prints payload larger than the legacy 16KB cap", async () => {
    env.CMP_PRICING_CONFIG_ENABLED = "true";
    mockGetToken.mockResolvedValue({ email: "admin@cmpsportswear.com", role: "admin" } as never);
    mockDbConfigured.mockReturnValue(true);

    const columnKeys = [
      "name", "effectivePrice", "description", "type", "geometryKey", "cogs",
      "operatorOperatingCost", "enginePrice", "policyFloor", "manualOverride",
      "grossMargin", "status", "operatorMinPerShirt", "designerMinPerOrder",
    ];
    const largeConfig = {
      services: Array.from({ length: 50 }, (_, i) => ({
        key: `service_${i}`,
        name: `Service ${i}`.padEnd(100, " "),
        description: "d".repeat(500),
        type: "service" as const,
        geometryKey: null,
        composition: [{ sizeKey: "FLAT_LARGE", quantityPerShirt: 1 }],
        cogs: 1.23,
        operatorOperatingCost: 0.1,
        enginePrice: 5,
        policyFloor: 0,
        manualOverride: null,
        effectivePrice: 5,
        grossMargin: 0.5,
        status: "Engine price",
        operatorMinPerShirt: 0,
        designerMinPerOrder: 0,
        active: true,
        sortOrder: i,
      })),
      columns: columnKeys.map((key, i) => ({
        key,
        label: key,
        required: key === "name" || key === "effectivePrice",
        visible: true,
        order: i,
      })),
      minimumBillableQuantity: 12,
    };
    const payload = { configType: "additional_prints", data: largeConfig, expectedVersion: null };
    const bodyBytes = Buffer.byteLength(JSON.stringify(payload));
    // Confirms this payload genuinely exercises the raised cap: too big for the
    // legacy 16KB limit, comfortably inside the route-specific limit.
    expect(bodyBytes).toBeGreaterThan(16_384);
    expect(bodyBytes).toBeLessThan(MAX_PRICING_CONFIG_BODY_BYTES);

    const saveAndActivate = vi.fn().mockResolvedValue({
      ok: true,
      version: { ...SAMPLE_VERSION, configType: "additional_prints", data: largeConfig },
    });
    mockGetRepo.mockReturnValue({
      getActiveVersion: vi.fn(),
      getVersion: vi.fn(),
      listVersions: vi.fn(),
      saveAndActivate,
      activateVersion: vi.fn(),
    } as never);

    const res = await PUT(putRequest(payload));
    expect(res.status).toBe(200);
    expect(saveAndActivate).toHaveBeenCalled();
  });

  it("a representative max-valid Additional Prints payload (every field at its schema maximum, ASCII) stays under the cap", async () => {
    // Proves the schema's own bounds (composition length, sizeKey,
    // geometryKey, status, description/name/key/labels) are enough to
    // guarantee any schema-valid payload fits under MAX_PRICING_CONFIG_BODY_BYTES,
    // not just typical-sized ones.
    const columnKeys = [
      "name", "effectivePrice", "description", "type", "geometryKey", "cogs",
      "operatorOperatingCost", "enginePrice", "policyFloor", "manualOverride",
      "grossMargin", "status", "operatorMinPerShirt", "designerMinPerOrder",
    ];
    const maxConfig = {
      services: Array.from({ length: 50 }, (_, i) => ({
        key: `service_key_${i}`.padEnd(60, "k").slice(0, 60),
        name: `Service ${i}`.padEnd(100, "n").slice(0, 100),
        description: "d".repeat(500),
        type: "service" as const,
        geometryKey: "g".repeat(60),
        composition: Array.from({ length: 20 }, (_, j) => ({
          sizeKey: `size_key_${j}`.padEnd(60, "s").slice(0, 60),
          quantityPerShirt: 1,
        })),
        cogs: 1.23,
        operatorOperatingCost: 0.1,
        enginePrice: 5,
        policyFloor: 0,
        manualOverride: 5,
        effectivePrice: 5,
        grossMargin: 0.5,
        status: "s".repeat(100),
        operatorMinPerShirt: 0,
        designerMinPerOrder: 0,
        active: true,
        sortOrder: i,
      })),
      // 30 is the schema max for columns, but only ALL_COLUMN_KEYS (14) are
      // valid keys — pad with repeated-but-unique-order entries is not
      // possible since keys must be unique, so this uses the real max of
      // distinct valid column keys.
      columns: columnKeys.map((key, i) => ({
        key,
        label: key.padEnd(60, "l").slice(0, 60),
        required: key === "name" || key === "effectivePrice",
        visible: true,
        order: i,
      })),
      minimumBillableQuantity: 12,
    };
    const payload = { configType: "additional_prints", data: maxConfig, expectedVersion: null };
    const bodyBytes = Buffer.byteLength(JSON.stringify(payload));
    expect(bodyBytes).toBeLessThan(MAX_PRICING_CONFIG_BODY_BYTES);

    mockDbConfigured.mockReturnValue(true);
    mockGetToken.mockResolvedValue({ email: "admin@cmpsportswear.com", role: "admin" } as never);
    env.CMP_PRICING_CONFIG_ENABLED = "true";
    const saveAndActivate = vi.fn().mockResolvedValue({
      ok: true,
      version: { ...SAMPLE_VERSION, configType: "additional_prints", data: maxConfig },
    });
    mockGetRepo.mockReturnValue({
      getActiveVersion: vi.fn(),
      getVersion: vi.fn(),
      listVersions: vi.fn(),
      saveAndActivate,
      activateVersion: vi.fn(),
    } as never);

    const res = await PUT(putRequest(payload));
    expect(res.status).toBe(200);
  });

  it("a representative max-valid DTF matrix payload (20 lanes, 50 tiers, full price records, ASCII) stays under the cap", async () => {
    const laneKeys = Array.from({ length: 20 }, (_, i) => `LANE_${i}`.padEnd(20, "x").slice(0, 20));
    const lanes = laneKeys.map((key) => ({
      key,
      label: key.padEnd(50, "l").slice(0, 50),
      margin: 0.5,
      active: true,
    }));
    const tiers = Array.from({ length: 50 }, (_, i) => {
      const minQty = i * 10 + 1;
      const isLast = i === 49;
      const prices: Record<string, number> = {};
      for (const key of laneKeys) prices[key] = 12.34;
      return {
        tier: `${minQty}+`.padEnd(30, "0").slice(0, 30),
        minQty,
        maxQty: isLast ? null : minQty + 9,
        prices,
      };
    });
    const maxConfig = { lanes, tiers };
    const payload = { configType: "dtf_matrix", data: maxConfig, expectedVersion: null };
    const bodyBytes = Buffer.byteLength(JSON.stringify(payload));
    expect(bodyBytes).toBeLessThan(MAX_PRICING_CONFIG_BODY_BYTES);

    mockDbConfigured.mockReturnValue(true);
    mockGetToken.mockResolvedValue({ email: "admin@cmpsportswear.com", role: "admin" } as never);
    env.CMP_PRICING_CONFIG_ENABLED = "true";
    const saveAndActivate = vi.fn().mockResolvedValue({
      ok: true,
      version: { ...SAMPLE_VERSION, data: maxConfig },
    });
    mockGetRepo.mockReturnValue({
      getActiveVersion: vi.fn(),
      getVersion: vi.fn(),
      listVersions: vi.fn(),
      saveAndActivate,
      activateVersion: vi.fn(),
    } as never);

    const res = await PUT(putRequest(payload));
    expect(res.status).toBe(200);
  });

  it("accepts a worst-case Unicode/escaping max-valid Additional Prints payload just under the cap", async () => {
    // The ASCII max-length tests above don't exercise the real worst case:
    // Zod's `.max(n)` on a string bounds `.length` (UTF-16 code units), and
    // an attacker- or user-controlled string can encode each unit on the wire
    // as a `\uXXXX` JSON escape (6 bytes/unit — the maximum possible
    // expansion). This builds every bounded string field at its schema
    // maximum using that worst-case escaping and confirms it still clears
    // under the cap, proving the cap wasn't sized only against plain ASCII.
    const ESCAPE_CHAR = String.fromCharCode(1); // U+0001 ->  (6 bytes)
    const worstStr = (n: number, tag: string) =>
      ESCAPE_CHAR.repeat(Math.max(0, n - tag.length)) + tag;

    const columnKeys = [
      "name", "effectivePrice", "description", "type", "geometryKey", "cogs",
      "operatorOperatingCost", "enginePrice", "policyFloor", "manualOverride",
      "grossMargin", "status", "operatorMinPerShirt", "designerMinPerOrder",
    ];
    const maxConfig = {
      services: Array.from({ length: 50 }, (_, i) => ({
        key: worstStr(60, `k${i}`),
        name: worstStr(100, `n${i}`),
        description: worstStr(500, `d${i}`),
        type: "service" as const,
        geometryKey: worstStr(60, `g${i}`),
        composition: Array.from({ length: 20 }, (_, j) => ({
          sizeKey: worstStr(60, `s${i}_${j}`),
          quantityPerShirt: 999999999,
        })),
        cogs: 99999.999999999,
        operatorOperatingCost: 99999.999999999,
        enginePrice: 999999999,
        policyFloor: 99999.999999999,
        manualOverride: 99999.999999999,
        effectivePrice: 99999.999999999,
        grossMargin: 0.999999999999999,
        status: worstStr(100, `st${i}`),
        operatorMinPerShirt: 99999.999999999,
        designerMinPerOrder: 99999.999999999,
        active: i === 0,
        sortOrder: i,
      })),
      columns: columnKeys.map((key, i) => ({
        key,
        label: worstStr(60, `cl${i}`),
        required: key === "name" || key === "effectivePrice",
        visible: true,
        order: i,
      })),
      minimumBillableQuantity: 999999999,
    };
    const payload = { configType: "additional_prints", data: maxConfig, expectedVersion: null };
    const bodyBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
    expect(bodyBytes).toBeLessThan(MAX_PRICING_CONFIG_BODY_BYTES);

    mockDbConfigured.mockReturnValue(true);
    mockGetToken.mockResolvedValue({ email: "admin@cmpsportswear.com", role: "admin" } as never);
    env.CMP_PRICING_CONFIG_ENABLED = "true";
    const saveAndActivate = vi.fn().mockResolvedValue({
      ok: true,
      version: { ...SAMPLE_VERSION, configType: "additional_prints", data: maxConfig },
    });
    mockGetRepo.mockReturnValue({
      getActiveVersion: vi.fn(),
      getVersion: vi.fn(),
      listVersions: vi.fn(),
      saveAndActivate,
      activateVersion: vi.fn(),
    } as never);

    const res = await PUT(putRequest(payload));
    expect(res.status).toBe(200);
    expect(saveAndActivate).toHaveBeenCalled();
  });

  it("returns 413 for a multibyte/escaped streamed body over the cap, without a Content-Length header", async () => {
    env.CMP_PRICING_CONFIG_ENABLED = "true";
    mockGetToken.mockResolvedValue({ email: "admin@cmpsportswear.com", role: "admin" } as never);
    // Multibyte padding (not ASCII repeat("p")) to confirm the streaming
    // byte-counter is measuring real UTF-8 bytes off the wire, not JS string
    // length, so multibyte content can't sneak past the cap either.
    const hugeBody = JSON.stringify({
      configType: "additional_prints",
      data: {},
      expectedVersion: null,
      _pad: "\u{1F600}".repeat(300_000), // 4 UTF-8 bytes each -> ~1.2MB, over the 1MiB cap
    });
    const res = await PUT(
      request(BASE_URL, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost",
          // No Content-Length: exercises the true streaming byte-count path.
        },
        body: hugeBody,
      })
    );
    expect(res.status).toBe(413);
  });

  it("returns 400 for malformed JSON", async () => {
    env.CMP_PRICING_CONFIG_ENABLED = "true";
    mockGetToken.mockResolvedValue({ email: "admin@cmpsportswear.com", role: "admin" } as never);
    const res = await PUT(
      request(BASE_URL, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost",
        },
        body: "not valid json{",
      })
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid schema (missing required fields)", async () => {
    env.CMP_PRICING_CONFIG_ENABLED = "true";
    mockGetToken.mockResolvedValue({ email: "admin@cmpsportswear.com", role: "admin" } as never);
    const res = await PUT(putRequest({ configType: "dtf_matrix", data: {}, expectedVersion: null }));
    expect(res.status).toBe(400);
  });

  it("returns 401 when the token has no email (requireRole treats it as unauthenticated)", async () => {
    env.CMP_PRICING_CONFIG_ENABLED = "true";
    mockGetToken.mockResolvedValue({ role: "admin" } as never);
    const res = await PUT(
      putRequest({ configType: "dtf_matrix", data: VALID_DTF_MATRIX, expectedVersion: null })
    );
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toContain("Authentication required");
  });

  it("returns 503 when the database is not configured", async () => {
    env.CMP_PRICING_CONFIG_ENABLED = "true";
    mockGetToken.mockResolvedValue({ email: "admin@cmpsportswear.com", role: "admin" } as never);
    mockDbConfigured.mockReturnValue(false);
    const res = await PUT(
      putRequest({ configType: "dtf_matrix", data: VALID_DTF_MATRIX, expectedVersion: null })
    );
    expect(res.status).toBe(503);
  });

  it("saves and activates a new version, returning its metadata", async () => {
    env.CMP_PRICING_CONFIG_ENABLED = "true";
    mockGetToken.mockResolvedValue({ email: "admin@cmpsportswear.com", role: "admin" } as never);
    mockDbConfigured.mockReturnValue(true);
    const saveAndActivate = vi.fn().mockResolvedValue({ ok: true, version: SAMPLE_VERSION });
    mockGetRepo.mockReturnValue({
      getActiveVersion: vi.fn(),
      getVersion: vi.fn(),
      listVersions: vi.fn(),
      saveAndActivate,
      activateVersion: vi.fn(),
    } as never);

    const res = await PUT(
      putRequest({ configType: "dtf_matrix", data: VALID_DTF_MATRIX, expectedVersion: null })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.version.id).toBe(SAMPLE_VERSION.id);
    expect(saveAndActivate).toHaveBeenCalledWith(
      "dtf_matrix",
      VALID_DTF_MATRIX,
      "admin@cmpsportswear.com",
      null
    );
  });

  it("returns 409 when the active version has changed concurrently", async () => {
    env.CMP_PRICING_CONFIG_ENABLED = "true";
    mockGetToken.mockResolvedValue({ email: "admin@cmpsportswear.com", role: "admin" } as never);
    mockDbConfigured.mockReturnValue(true);
    mockGetRepo.mockReturnValue({
      getActiveVersion: vi.fn(),
      getVersion: vi.fn(),
      listVersions: vi.fn(),
      saveAndActivate: vi.fn().mockResolvedValue({
        ok: false,
        reason: "conflict",
        message: "Another admin may have saved changes.",
      }),
      activateVersion: vi.fn(),
    } as never);

    const res = await PUT(
      putRequest({ configType: "dtf_matrix", data: VALID_DTF_MATRIX, expectedVersion: null })
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("Another admin may have saved changes");
  });

  it("returns 503 when the repository throws", async () => {
    env.CMP_PRICING_CONFIG_ENABLED = "true";
    mockGetToken.mockResolvedValue({ email: "admin@cmpsportswear.com", role: "admin" } as never);
    mockDbConfigured.mockReturnValue(true);
    mockGetRepo.mockReturnValue({
      getActiveVersion: vi.fn(),
      getVersion: vi.fn(),
      listVersions: vi.fn(),
      saveAndActivate: vi.fn().mockRejectedValue(new Error("connection refused")),
      activateVersion: vi.fn(),
    } as never);

    const res = await PUT(
      putRequest({ configType: "dtf_matrix", data: VALID_DTF_MATRIX, expectedVersion: null })
    );
    expect(res.status).toBe(503);
  });
});
