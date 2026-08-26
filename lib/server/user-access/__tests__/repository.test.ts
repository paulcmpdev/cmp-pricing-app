import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createPostgresUserAccessRepository } from "../postgres-repository";
import type { UserAccessRepository } from "../types";

/**
 * Unit tests for the user-access repository using a mock PG pool.
 * Tests email normalization, mutation invariants, version conflicts,
 * bootstrap lock, and final-admin protection.
 */

const env = process.env as Record<string, string | undefined>;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ["CMP_ADMIN_EMAILS", "CMP_ALLOWED_GOOGLE_DOMAIN"] as const;

for (const k of ENV_KEYS) savedEnv[k] = env[k];

function setEnv() {
  env.CMP_ADMIN_EMAILS =
    "bootstrap@cmpsportswear.com,admin@cmpsportswear.com";
  env.CMP_ALLOWED_GOOGLE_DOMAIN = "cmpsportswear.com";
}

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete env[k];
    else env[k] = savedEnv[k];
  }
});

// ---------------------------------------------------------------------------
// Mock pool helpers
// ---------------------------------------------------------------------------

type QueryResult = { rows: Record<string, unknown>[] };

function createMockPool(queryFn: (text: string, values?: unknown[]) => QueryResult) {
  const mockClient = {
    query: vi.fn((text: string, values?: unknown[]) => Promise.resolve(queryFn(text, values))),
    release: vi.fn(),
  };
  return {
    query: vi.fn((text: string, values?: unknown[]) => Promise.resolve(queryFn(text, values))),
    connect: vi.fn(() => Promise.resolve(mockClient)),
    _client: mockClient,
  };
}

function makeUserRow(overrides: Record<string, unknown> = {}) {
  return {
    email: "user@cmpsportswear.com",
    name: "Test User",
    image: null,
    role: null,
    status: "pending",
    version: 1,
    created_at: new Date("2026-01-01"),
    updated_at: new Date("2026-01-01"),
    last_sign_in_at: null,
    ...overrides,
  };
}

function makeEventRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "test-event-id",
    user_email: "user@cmpsportswear.com",
    action: "access_requested",
    actor_email: "user@cmpsportswear.com",
    before_role: null,
    after_role: null,
    before_status: null,
    after_status: "pending",
    created_at: new Date("2026-01-01"),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("email normalization", () => {
  it("normalizes email to lowercase in getUser", async () => {
    setEnv();
    let capturedEmail: unknown;
    const pool = createMockPool((text, values) => {
      if (text.includes("SELECT") && values) capturedEmail = values[0];
      return { rows: [] };
    });
    const repo = createPostgresUserAccessRepository(pool as any);
    await repo.getUser("User@CMPSportswear.COM");
    expect(capturedEmail).toBe("user@cmpsportswear.com");
  });
});

describe("requestAccess", () => {
  it("creates a pending user with audit event for unknown email", async () => {
    setEnv();
    const userRow = makeUserRow();
    const eventRow = makeEventRow();
    let userSelectCount = 0;
    const pool = createMockPool((text) => {
      if (text.includes("SELECT") && text.includes("app_users")) {
        userSelectCount += 1;
        return { rows: userSelectCount === 1 ? [] : [userRow] };
      }
      if (text.includes("INSERT") && text.includes("app_users")) return { rows: [] };
      if (text.includes("INSERT") && text.includes("RETURNING")) return { rows: [eventRow] };
      return { rows: [] };
    });
    const repo = createPostgresUserAccessRepository(pool as any);
    const result = await repo.requestAccess({
      email: "user@cmpsportswear.com",
      name: "Test User",
      image: null,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.user.status).toBe("pending");
      expect(result.event.action).toBe("access_requested");
    }
    expect(pool._client.query).toHaveBeenCalledWith(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      ["user@cmpsportswear.com"]
    );
  });

  it("is idempotent for existing users", async () => {
    setEnv();
    const userRow = makeUserRow({ status: "active", role: "sales_rep" });
    const eventRow = makeEventRow();
    const pool = createMockPool((text) => {
      if (text.includes("SELECT")) return { rows: [userRow] };
      if (text.includes("UPDATE")) return { rows: [] };
      if (text.includes("INSERT") && text.includes("RETURNING")) return { rows: [eventRow] };
      return { rows: [] };
    });
    const repo = createPostgresUserAccessRepository(pool as any);
    const result = await repo.requestAccess({
      email: "user@cmpsportswear.com",
      name: "Test",
      image: null,
    });
    expect(result.ok).toBe(true);
  });
});

describe("approveUser", () => {
  it("rejects on version mismatch", async () => {
    setEnv();
    const userRow = makeUserRow({ version: 2 });
    const pool = createMockPool((text) => {
      if (text.includes("FOR UPDATE")) return { rows: [userRow] };
      return { rows: [] };
    });
    const repo = createPostgresUserAccessRepository(pool as any);
    const result = await repo.approveUser({
      email: "user@cmpsportswear.com",
      role: "sales_rep",
      actorEmail: "admin@cmpsportswear.com",
      expectedVersion: 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("conflict");
  });

  it("rejects if user is not pending", async () => {
    setEnv();
    const userRow = makeUserRow({ status: "active", role: "sales_rep", version: 1 });
    const pool = createMockPool((text) => {
      if (text.includes("FOR UPDATE")) return { rows: [userRow] };
      return { rows: [] };
    });
    const repo = createPostgresUserAccessRepository(pool as any);
    const result = await repo.approveUser({
      email: "user@cmpsportswear.com",
      role: "sales_rep",
      actorEmail: "admin@cmpsportswear.com",
      expectedVersion: 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("conflict");
  });

  it("returns not_found for unknown user", async () => {
    setEnv();
    const pool = createMockPool(() => ({ rows: [] }));
    const repo = createPostgresUserAccessRepository(pool as any);
    const result = await repo.approveUser({
      email: "nobody@cmpsportswear.com",
      role: "sales_rep",
      actorEmail: "admin@cmpsportswear.com",
      expectedVersion: 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not_found");
  });
});

describe("changeRole", () => {
  it("rejects bootstrap admin role change", async () => {
    setEnv();
    const pool = createMockPool(() => ({ rows: [] }));
    const repo = createPostgresUserAccessRepository(pool as any);
    const result = await repo.changeRole({
      email: "bootstrap@cmpsportswear.com",
      role: "sales_rep",
      actorEmail: "admin@cmpsportswear.com",
      expectedVersion: 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("forbidden");
  });

  it("rejects a role change when the selected role is unchanged", async () => {
    setEnv();
    const userRow = makeUserRow({
      email: "rep@cmpsportswear.com",
      status: "active",
      role: "sales_rep",
      version: 1,
    });
    const eventRow = makeEventRow({
      user_email: userRow.email,
      action: "role_changed",
      actor_email: "admin@cmpsportswear.com",
      before_role: "sales_rep",
      after_role: "sales_rep",
      before_status: "active",
      after_status: "active",
    });
    const pool = createMockPool((text) => {
      if (text.includes("FOR UPDATE")) return { rows: [userRow] };
      if (text.includes("INSERT") && text.includes("RETURNING")) {
        return { rows: [eventRow] };
      }
      if (text.includes("SELECT * FROM app_users")) {
        return { rows: [{ ...userRow, version: 2 }] };
      }
      return { rows: [] };
    });
    const repo = createPostgresUserAccessRepository(pool as any);

    const result = await repo.changeRole({
      email: userRow.email,
      role: "sales_rep",
      actorEmail: "admin@cmpsportswear.com",
      expectedVersion: 1,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("conflict");
    expect(
      pool._client.query.mock.calls.some(([text]) =>
        String(text).includes("UPDATE app_users")
      )
    ).toBe(false);
    expect(
      pool._client.query.mock.calls.some(([text]) =>
        String(text).includes("INSERT INTO app_user_access_events")
      )
    ).toBe(false);
  });

  it("prevents demoting the last active admin when no bootstrap admin exists", async () => {
    setEnv();
    env.CMP_ADMIN_EMAILS = "";
    const userRow = makeUserRow({
      email: "sole-admin@cmpsportswear.com",
      status: "active",
      role: "admin",
      version: 1,
    });
    const pool = createMockPool((text) => {
      if (text.includes("SELECT role, status")) return { rows: [userRow] };
      if (text.includes("FOR UPDATE")) return { rows: [userRow] };
      if (text.includes("count(*)")) return { rows: [{ count: "1" }] };
      return { rows: [] };
    });
    const repo = createPostgresUserAccessRepository(pool as any);
    const result = await repo.changeRole({
      email: userRow.email,
      role: "sales_rep",
      actorEmail: userRow.email,
      expectedVersion: 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("forbidden");
  });

  it("allows demoting a database admin when a bootstrap admin remains", async () => {
    setEnv();
    const userRow = makeUserRow({
      email: "watson@cmpsportswear.com",
      status: "active",
      role: "admin",
      version: 1,
    });
    const updatedRow = { ...userRow, role: "manager", version: 2 };
    const eventRow = makeEventRow({
      user_email: userRow.email,
      action: "role_changed",
      actor_email: "bootstrap@cmpsportswear.com",
      before_role: "admin",
      after_role: "manager",
      before_status: "active",
      after_status: "active",
    });
    const pool = createMockPool((text) => {
      if (text.includes("FOR UPDATE")) return { rows: [userRow] };
      if (text.includes("INSERT") && text.includes("RETURNING")) {
        return { rows: [eventRow] };
      }
      if (text.includes("SELECT * FROM app_users")) return { rows: [updatedRow] };
      return { rows: [] };
    });
    const repo = createPostgresUserAccessRepository(pool as any);

    const result = await repo.changeRole({
      email: userRow.email,
      role: "manager",
      actorEmail: "bootstrap@cmpsportswear.com",
      expectedVersion: 1,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.user.role).toBe("manager");
    expect(
      pool._client.query.mock.calls.some(([text]) =>
        String(text).includes("count(*)")
      )
    ).toBe(false);
  });
});

describe("disableUser", () => {
  it("rejects disabling a bootstrap admin", async () => {
    setEnv();
    const pool = createMockPool(() => ({ rows: [] }));
    const repo = createPostgresUserAccessRepository(pool as any);
    const result = await repo.disableUser({
      email: "bootstrap@cmpsportswear.com",
      actorEmail: "admin@cmpsportswear.com",
      expectedVersion: 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("forbidden");
  });

  it("prevents disabling the last active admin when no bootstrap admin exists", async () => {
    setEnv();
    env.CMP_ADMIN_EMAILS = "";
    const userRow = makeUserRow({
      email: "sole-admin@cmpsportswear.com",
      status: "active",
      role: "admin",
      version: 1,
    });
    const pool = createMockPool((text) => {
      if (text.includes("SELECT role, status")) return { rows: [userRow] };
      if (text.includes("FOR UPDATE")) return { rows: [userRow] };
      if (text.includes("count(*)")) return { rows: [{ count: "1" }] };
      return { rows: [] };
    });
    const repo = createPostgresUserAccessRepository(pool as any);
    const result = await repo.disableUser({
      email: userRow.email,
      actorEmail: userRow.email,
      expectedVersion: 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("forbidden");
  });

  it("allows disabling a database admin when a bootstrap admin remains", async () => {
    setEnv();
    const userRow = makeUserRow({
      email: "watson@cmpsportswear.com",
      status: "active",
      role: "admin",
      version: 1,
    });
    const updatedRow = { ...userRow, status: "disabled", version: 2 };
    const eventRow = makeEventRow({
      user_email: userRow.email,
      action: "disabled",
      actor_email: "bootstrap@cmpsportswear.com",
      before_role: "admin",
      after_role: "admin",
      before_status: "active",
      after_status: "disabled",
    });
    const pool = createMockPool((text) => {
      if (text.includes("FOR UPDATE")) return { rows: [userRow] };
      if (text.includes("INSERT") && text.includes("RETURNING")) {
        return { rows: [eventRow] };
      }
      if (text.includes("SELECT * FROM app_users")) return { rows: [updatedRow] };
      return { rows: [] };
    });
    const repo = createPostgresUserAccessRepository(pool as any);

    const result = await repo.disableUser({
      email: userRow.email,
      actorEmail: "bootstrap@cmpsportswear.com",
      expectedVersion: 1,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.user.status).toBe("disabled");
    expect(
      pool._client.query.mock.calls.some(([text]) =>
        String(text).includes("count(*)")
      )
    ).toBe(false);
  });

  it("rejects disabling an already disabled user", async () => {
    setEnv();
    const userRow = makeUserRow({
      email: "disabled@cmpsportswear.com",
      status: "disabled",
      role: "sales_rep",
      version: 2,
    });
    const pool = createMockPool((text) => {
      if (text.includes("FOR UPDATE")) return { rows: [userRow] };
      return { rows: [] };
    });
    const repo = createPostgresUserAccessRepository(pool as any);
    const result = await repo.disableUser({
      email: "disabled@cmpsportswear.com",
      actorEmail: "admin@cmpsportswear.com",
      expectedVersion: 2,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("conflict");
  });
});

describe("reEnableUser", () => {
  it("rejects if user is not disabled", async () => {
    setEnv();
    const userRow = makeUserRow({
      email: "active@cmpsportswear.com",
      status: "active",
      role: "sales_rep",
      version: 1,
    });
    const pool = createMockPool((text) => {
      if (text.includes("FOR UPDATE")) return { rows: [userRow] };
      return { rows: [] };
    });
    const repo = createPostgresUserAccessRepository(pool as any);
    const result = await repo.reEnableUser({
      email: "active@cmpsportswear.com",
      role: "sales_rep",
      actorEmail: "admin@cmpsportswear.com",
      expectedVersion: 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("conflict");
  });
});

describe("preAuthorize", () => {
  it("revalidates a non-bootstrap actor inside the transaction", async () => {
    setEnv();
    env.CMP_ADMIN_EMAILS = "bootstrap@cmpsportswear.com";
    const revokedActor = makeUserRow({
      email: "admin@cmpsportswear.com",
      role: "admin",
      status: "disabled",
    });
    const pool = createMockPool((text, values) => {
      if (text.includes("SELECT role, status") && values?.[0] === revokedActor.email) {
        return { rows: [revokedActor] };
      }
      return { rows: [] };
    });
    const repo = createPostgresUserAccessRepository(pool as any);
    const result = await repo.preAuthorize({
      email: "new@cmpsportswear.com",
      role: "sales_rep",
      actorEmail: revokedActor.email,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("forbidden");
    expect(
      pool._client.query.mock.calls.some(([text]) =>
        String(text).includes("INSERT INTO app_users")
      )
    ).toBe(false);
  });

  it("returns conflict for existing users", async () => {
    setEnv();
    const userRow = makeUserRow();
    const pool = createMockPool((text) => {
      if (text.includes("SELECT")) return { rows: [userRow] };
      return { rows: [] };
    });
    const repo = createPostgresUserAccessRepository(pool as any);
    const result = await repo.preAuthorize({
      email: "user@cmpsportswear.com",
      role: "sales_rep",
      actorEmail: "admin@cmpsportswear.com",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("conflict");
    expect(pool._client.query).toHaveBeenCalledWith(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      ["user@cmpsportswear.com"]
    );
  });

  it("rejects pre-authorizing a bootstrap admin email", async () => {
    setEnv();
    const pool = createMockPool(() => ({ rows: [] }));
    const repo = createPostgresUserAccessRepository(pool as any);
    const result = await repo.preAuthorize({
      email: "bootstrap@cmpsportswear.com",
      role: "admin",
      actorEmail: "admin@cmpsportswear.com",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("forbidden");
  });
});

// ---------------------------------------------------------------------------
// Fix 4 regression: bootstrap email rejection on approve and reEnable
// ---------------------------------------------------------------------------

describe("bootstrap email rejection (Fix 4)", () => {
  it("rejects approving a bootstrap admin email", async () => {
    setEnv();
    const pool = createMockPool(() => ({ rows: [] }));
    const repo = createPostgresUserAccessRepository(pool as any);
    const result = await repo.approveUser({
      email: "bootstrap@cmpsportswear.com",
      role: "admin",
      actorEmail: "admin@cmpsportswear.com",
      expectedVersion: 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("forbidden");
  });

  it("rejects re-enabling a bootstrap admin email", async () => {
    setEnv();
    const pool = createMockPool(() => ({ rows: [] }));
    const repo = createPostgresUserAccessRepository(pool as any);
    const result = await repo.reEnableUser({
      email: "bootstrap@cmpsportswear.com",
      role: "admin",
      actorEmail: "admin@cmpsportswear.com",
      expectedVersion: 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("forbidden");
  });
});

// ---------------------------------------------------------------------------
// Fix 3 regression: advisory lock is called for admin-count-reducing mutations
// ---------------------------------------------------------------------------

describe("advisory lock for admin-count mutations (Fix 3)", () => {
  it("calls pg_advisory_xact_lock when demoting an admin", async () => {
    setEnv();
    const queryCalls: string[] = [];
    const userRow = makeUserRow({
      email: "admin2@cmpsportswear.com",
      status: "active",
      role: "admin",
      version: 1,
    });
    const pool = createMockPool((text) => {
      queryCalls.push(text);
      if (text.includes("FOR UPDATE")) return { rows: [userRow] };
      if (text.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (text.includes("count(*)")) return { rows: [{ count: "2" }] };
      if (text.includes("UPDATE")) return { rows: [] };
      if (text.includes("RETURNING")) return { rows: [makeEventRow()] };
      if (text.includes("SELECT") && text.includes("app_users")) return { rows: [makeUserRow({ role: "sales_rep", status: "active", version: 2 })] };
      return { rows: [] };
    });
    const repo = createPostgresUserAccessRepository(pool as any);
    await repo.changeRole({
      email: "admin2@cmpsportswear.com",
      role: "sales_rep",
      actorEmail: "bootstrap@cmpsportswear.com",
      expectedVersion: 1,
    });
    const clientCalls = pool._client.query.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(clientCalls.some((q: string) => q.includes("pg_advisory_xact_lock"))).toBe(true);
  });

  it("calls pg_advisory_xact_lock when disabling an admin", async () => {
    setEnv();
    const userRow = makeUserRow({
      email: "admin2@cmpsportswear.com",
      status: "active",
      role: "admin",
      version: 1,
    });
    const pool = createMockPool((text) => {
      if (text.includes("FOR UPDATE")) return { rows: [userRow] };
      if (text.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (text.includes("count(*)")) return { rows: [{ count: "2" }] };
      if (text.includes("UPDATE")) return { rows: [] };
      if (text.includes("RETURNING")) return { rows: [makeEventRow({ action: "disabled" })] };
      if (text.includes("SELECT") && text.includes("app_users")) return { rows: [makeUserRow({ status: "disabled", version: 2 })] };
      return { rows: [] };
    });
    const repo = createPostgresUserAccessRepository(pool as any);
    await repo.disableUser({
      email: "admin2@cmpsportswear.com",
      actorEmail: "bootstrap@cmpsportswear.com",
      expectedVersion: 1,
    });
    const clientCalls = pool._client.query.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(clientCalls.some((q: string) => q.includes("pg_advisory_xact_lock"))).toBe(true);
  });
});
