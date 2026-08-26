import type { Pool, PoolClient } from "pg";
import type {
  AppUser,
  AppUserAccessEvent,
  AppUserRole,
  AppUserStatus,
  AccessEventAction,
  MutationOutcome,
  UserAccessRepository,
} from "./types";
import { parseEmailList } from "../auth/policy";

function normalizeEmail(email: string): string {
  return email.toLowerCase().trim();
}

function isBootstrapAdmin(email: string): boolean {
  const admins = parseEmailList(process.env.CMP_ADMIN_EMAILS);
  return admins.includes(normalizeEmail(email));
}

function rowToUser(row: Record<string, unknown>): AppUser {
  return {
    email: row.email as string,
    name: (row.name as string) ?? null,
    image: (row.image as string) ?? null,
    role: (row.role as AppUserRole) ?? null,
    status: row.status as AppUserStatus,
    version: Number(row.version),
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
    lastSignInAt: row.last_sign_in_at
      ? (row.last_sign_in_at as Date).toISOString()
      : null,
  };
}

function rowToEvent(row: Record<string, unknown>): AppUserAccessEvent {
  return {
    id: row.id as string,
    userEmail: row.user_email as string,
    action: row.action as AccessEventAction,
    actorEmail: row.actor_email as string,
    beforeRole: (row.before_role as AppUserRole) ?? null,
    afterRole: (row.after_role as AppUserRole) ?? null,
    beforeStatus: (row.before_status as AppUserStatus) ?? null,
    afterStatus: (row.after_status as AppUserStatus) ?? null,
    createdAt: (row.created_at as Date).toISOString(),
  };
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

// Advisory lock key for serializing admin-count-reducing mutations.
// Chosen as a stable hash-like constant that won't collide with other locks.
const ADMIN_COUNT_LOCK_KEY = 839274017;
const USER_ACCESS_MUTATION_LOCK_KEY = 839274019;

async function authorizeAdminActor(
  client: PoolClient,
  actorEmail: string
): Promise<boolean> {
  await client.query("SELECT pg_advisory_xact_lock($1)", [
    USER_ACCESS_MUTATION_LOCK_KEY,
  ]);

  if (isBootstrapAdmin(actorEmail)) return true;

  const actor = await client.query(
    "SELECT role, status FROM app_users WHERE email = $1 FOR UPDATE",
    [actorEmail]
  );
  return (
    actor.rows.length === 1 &&
    actor.rows[0].role === "admin" &&
    actor.rows[0].status === "active"
  );
}

export function createPostgresUserAccessRepository(
  pool: Pool
): UserAccessRepository {
  return {
    async listUsers(): Promise<AppUser[]> {
      const result = await pool.query(
        "SELECT * FROM app_users ORDER BY updated_at DESC"
      );
      return result.rows.map(rowToUser);
    },

    async getUser(email: string): Promise<AppUser | null> {
      const result = await pool.query(
        "SELECT * FROM app_users WHERE email = $1",
        [normalizeEmail(email)]
      );
      return result.rows.length > 0 ? rowToUser(result.rows[0]) : null;
    },

    async getUserEvents(email: string): Promise<AppUserAccessEvent[]> {
      const result = await pool.query(
        "SELECT * FROM app_user_access_events WHERE user_email = $1 ORDER BY created_at DESC",
        [normalizeEmail(email)]
      );
      return result.rows.map(rowToEvent);
    },

    async requestAccess(params): Promise<MutationOutcome> {
      const email = normalizeEmail(params.email);

      return withTransaction(pool, async (client) => {
        // Serialize first-sign-in registration for the same normalized email.
        // This makes the SELECT/INSERT sequence idempotent under concurrent
        // OAuth callbacks without serializing unrelated users.
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [email]
        );

        // Idempotent: if user already exists, just return them
        const existing = await client.query(
          "SELECT * FROM app_users WHERE email = $1",
          [email]
        );
        if (existing.rows.length > 0) {
          // Update last sign-in
          await client.query(
            "UPDATE app_users SET last_sign_in_at = CURRENT_TIMESTAMP, name = COALESCE($2, name), image = COALESCE($3, image) WHERE email = $1",
            [email, params.name, params.image]
          );
          const refreshed = await client.query(
            "SELECT * FROM app_users WHERE email = $1",
            [email]
          );
          // Return without creating a duplicate audit event
          const events = await client.query(
            "SELECT * FROM app_user_access_events WHERE user_email = $1 ORDER BY created_at DESC LIMIT 1",
            [email]
          );
          return {
            ok: true,
            user: rowToUser(refreshed.rows[0]),
            event: events.rows.length > 0
              ? rowToEvent(events.rows[0])
              : {
                  id: "idempotent",
                  userEmail: email,
                  action: "access_requested" as AccessEventAction,
                  actorEmail: email,
                  beforeRole: null,
                  afterRole: null,
                  beforeStatus: null,
                  afterStatus: "pending" as AppUserStatus,
                  createdAt: new Date().toISOString(),
                },
          };
        }

        // Insert new pending user
        await client.query(
          `INSERT INTO app_users (email, name, image, role, status, version, last_sign_in_at)
           VALUES ($1, $2, $3, NULL, 'pending', 1, CURRENT_TIMESTAMP)`,
          [email, params.name ?? null, params.image ?? null]
        );

        // Append audit event
        const eventResult = await client.query(
          `INSERT INTO app_user_access_events
           (user_email, action, actor_email, before_role, after_role, before_status, after_status)
           VALUES ($1, 'access_requested', $1, NULL, NULL, NULL, 'pending')
           RETURNING *`,
          [email]
        );

        const user = await client.query(
          "SELECT * FROM app_users WHERE email = $1",
          [email]
        );

        return {
          ok: true,
          user: rowToUser(user.rows[0]),
          event: rowToEvent(eventResult.rows[0]),
        };
      });
    },

    async preAuthorize(params): Promise<MutationOutcome> {
      const email = normalizeEmail(params.email);
      const actorEmail = normalizeEmail(params.actorEmail);

      // Bootstrap admins cannot be pre-authorized (they always have access)
      if (isBootstrapAdmin(email)) {
        return {
          ok: false,
          reason: "forbidden",
          message: "Bootstrap admin emails cannot be pre-authorized.",
        };
      }

      return withTransaction(pool, async (client) => {
        if (!(await authorizeAdminActor(client, actorEmail))) {
          return {
            ok: false,
            reason: "forbidden",
            message: "The acting user is no longer an active Admin.",
          };
        }

        // Serialize competing pre-authorization attempts for this email so a
        // duplicate request returns a structured conflict instead of surfacing
        // a unique-constraint error as database unavailability.
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [email]
        );

        // If user already exists, return conflict
        const existing = await client.query(
          "SELECT * FROM app_users WHERE email = $1",
          [email]
        );
        if (existing.rows.length > 0) {
          return {
            ok: false,
            reason: "conflict",
            message: "User already exists.",
          };
        }

        await client.query(
          `INSERT INTO app_users (email, name, image, role, status, version)
           VALUES ($1, NULL, NULL, $2, 'active', 1)`,
          [email, params.role]
        );

        const eventResult = await client.query(
          `INSERT INTO app_user_access_events
           (user_email, action, actor_email, before_role, after_role, before_status, after_status)
           VALUES ($1, 'pre_authorized', $2, NULL, $3, NULL, 'active')
           RETURNING *`,
          [email, actorEmail, params.role]
        );

        const user = await client.query(
          "SELECT * FROM app_users WHERE email = $1",
          [email]
        );

        return {
          ok: true,
          user: rowToUser(user.rows[0]),
          event: rowToEvent(eventResult.rows[0]),
        };
      });
    },

    async approveUser(params): Promise<MutationOutcome> {
      const email = normalizeEmail(params.email);
      const actorEmail = normalizeEmail(params.actorEmail);

      // Bootstrap admins cannot be approved (they always have access)
      if (isBootstrapAdmin(email)) {
        return {
          ok: false,
          reason: "forbidden",
          message: "Bootstrap admin access cannot be modified.",
        };
      }

      return withTransaction(pool, async (client) => {
        if (!(await authorizeAdminActor(client, actorEmail))) {
          return {
            ok: false,
            reason: "forbidden",
            message: "The acting user is no longer an active Admin.",
          };
        }

        const locked = await client.query(
          "SELECT * FROM app_users WHERE email = $1 FOR UPDATE",
          [email]
        );
        if (locked.rows.length === 0) {
          return { ok: false, reason: "not_found" };
        }

        const current = locked.rows[0];
        if (Number(current.version) !== params.expectedVersion) {
          return {
            ok: false,
            reason: "conflict",
            message: `Expected version ${params.expectedVersion}, found ${current.version}.`,
          };
        }

        if (current.status !== "pending") {
          return {
            ok: false,
            reason: "conflict",
            message: `User is ${current.status}, not pending.`,
          };
        }

        const newVersion = Number(current.version) + 1;
        await client.query(
          `UPDATE app_users SET role = $2, status = 'active', version = $3, updated_at = CURRENT_TIMESTAMP
           WHERE email = $1`,
          [email, params.role, newVersion]
        );

        const eventResult = await client.query(
          `INSERT INTO app_user_access_events
           (user_email, action, actor_email, before_role, after_role, before_status, after_status)
           VALUES ($1, 'approved', $2, $3, $4, $5, 'active')
           RETURNING *`,
          [email, actorEmail, current.role, params.role, current.status]
        );

        const user = await client.query(
          "SELECT * FROM app_users WHERE email = $1",
          [email]
        );

        return {
          ok: true,
          user: rowToUser(user.rows[0]),
          event: rowToEvent(eventResult.rows[0]),
        };
      });
    },

    async changeRole(params): Promise<MutationOutcome> {
      const email = normalizeEmail(params.email);
      const actorEmail = normalizeEmail(params.actorEmail);

      // Bootstrap admins cannot be modified
      if (isBootstrapAdmin(email)) {
        return {
          ok: false,
          reason: "forbidden",
          message: "Bootstrap admin roles cannot be changed.",
        };
      }

      return withTransaction(pool, async (client) => {
        if (!(await authorizeAdminActor(client, actorEmail))) {
          return {
            ok: false,
            reason: "forbidden",
            message: "The acting user is no longer an active Admin.",
          };
        }

        const locked = await client.query(
          "SELECT * FROM app_users WHERE email = $1 FOR UPDATE",
          [email]
        );
        if (locked.rows.length === 0) {
          return { ok: false, reason: "not_found" };
        }

        const current = locked.rows[0];
        if (Number(current.version) !== params.expectedVersion) {
          return {
            ok: false,
            reason: "conflict",
            message: `Expected version ${params.expectedVersion}, found ${current.version}.`,
          };
        }

        if (current.status !== "active") {
          return {
            ok: false,
            reason: "conflict",
            message: `User is ${current.status}, not active.`,
          };
        }

        if (current.role === params.role) {
          return {
            ok: false,
            reason: "conflict",
            message: `User already has the ${params.role} role.`,
          };
        }

        // Final admin protection: cannot demote the last active admin
        if (current.role === "admin" && params.role !== "admin") {
          // Serialize admin-count-reducing mutations to prevent races
          await client.query("SELECT pg_advisory_xact_lock($1)", [ADMIN_COUNT_LOCK_KEY]);
          const adminCount = await client.query(
            "SELECT count(*) FROM app_users WHERE role = 'admin' AND status = 'active'",
          );
          if (Number(adminCount.rows[0].count) <= 1) {
            return {
              ok: false,
              reason: "forbidden",
              message: "Cannot demote the last active admin.",
            };
          }
        }

        const newVersion = Number(current.version) + 1;
        await client.query(
          `UPDATE app_users SET role = $2, version = $3, updated_at = CURRENT_TIMESTAMP
           WHERE email = $1`,
          [email, params.role, newVersion]
        );

        const eventResult = await client.query(
          `INSERT INTO app_user_access_events
           (user_email, action, actor_email, before_role, after_role, before_status, after_status)
           VALUES ($1, 'role_changed', $2, $3, $4, 'active', 'active')
           RETURNING *`,
          [email, actorEmail, current.role, params.role]
        );

        const user = await client.query(
          "SELECT * FROM app_users WHERE email = $1",
          [email]
        );

        return {
          ok: true,
          user: rowToUser(user.rows[0]),
          event: rowToEvent(eventResult.rows[0]),
        };
      });
    },

    async disableUser(params): Promise<MutationOutcome> {
      const email = normalizeEmail(params.email);
      const actorEmail = normalizeEmail(params.actorEmail);

      // Bootstrap admins cannot be disabled
      if (isBootstrapAdmin(email)) {
        return {
          ok: false,
          reason: "forbidden",
          message: "Bootstrap admins cannot be disabled.",
        };
      }

      return withTransaction(pool, async (client) => {
        if (!(await authorizeAdminActor(client, actorEmail))) {
          return {
            ok: false,
            reason: "forbidden",
            message: "The acting user is no longer an active Admin.",
          };
        }

        const locked = await client.query(
          "SELECT * FROM app_users WHERE email = $1 FOR UPDATE",
          [email]
        );
        if (locked.rows.length === 0) {
          return { ok: false, reason: "not_found" };
        }

        const current = locked.rows[0];
        if (Number(current.version) !== params.expectedVersion) {
          return {
            ok: false,
            reason: "conflict",
            message: `Expected version ${params.expectedVersion}, found ${current.version}.`,
          };
        }

        if (current.status === "disabled") {
          return {
            ok: false,
            reason: "conflict",
            message: "User is already disabled.",
          };
        }

        // Final admin protection
        if (current.role === "admin" && current.status === "active") {
          // Serialize admin-count-reducing mutations to prevent races
          await client.query("SELECT pg_advisory_xact_lock($1)", [ADMIN_COUNT_LOCK_KEY]);
          const adminCount = await client.query(
            "SELECT count(*) FROM app_users WHERE role = 'admin' AND status = 'active'",
          );
          if (Number(adminCount.rows[0].count) <= 1) {
            return {
              ok: false,
              reason: "forbidden",
              message: "Cannot disable the last active admin.",
            };
          }
        }

        const newVersion = Number(current.version) + 1;
        await client.query(
          `UPDATE app_users SET status = 'disabled', version = $2, updated_at = CURRENT_TIMESTAMP
           WHERE email = $1`,
          [email, newVersion]
        );

        const eventResult = await client.query(
          `INSERT INTO app_user_access_events
           (user_email, action, actor_email, before_role, after_role, before_status, after_status)
           VALUES ($1, 'disabled', $2, $3, $3, $4, 'disabled')
           RETURNING *`,
          [email, actorEmail, current.role, current.status]
        );

        const user = await client.query(
          "SELECT * FROM app_users WHERE email = $1",
          [email]
        );

        return {
          ok: true,
          user: rowToUser(user.rows[0]),
          event: rowToEvent(eventResult.rows[0]),
        };
      });
    },

    async reEnableUser(params): Promise<MutationOutcome> {
      const email = normalizeEmail(params.email);
      const actorEmail = normalizeEmail(params.actorEmail);

      // Bootstrap admins cannot be re-enabled (they always have access)
      if (isBootstrapAdmin(email)) {
        return {
          ok: false,
          reason: "forbidden",
          message: "Bootstrap admin access cannot be modified.",
        };
      }

      return withTransaction(pool, async (client) => {
        if (!(await authorizeAdminActor(client, actorEmail))) {
          return {
            ok: false,
            reason: "forbidden",
            message: "The acting user is no longer an active Admin.",
          };
        }

        const locked = await client.query(
          "SELECT * FROM app_users WHERE email = $1 FOR UPDATE",
          [email]
        );
        if (locked.rows.length === 0) {
          return { ok: false, reason: "not_found" };
        }

        const current = locked.rows[0];
        if (Number(current.version) !== params.expectedVersion) {
          return {
            ok: false,
            reason: "conflict",
            message: `Expected version ${params.expectedVersion}, found ${current.version}.`,
          };
        }

        if (current.status !== "disabled") {
          return {
            ok: false,
            reason: "conflict",
            message: `User is ${current.status}, not disabled.`,
          };
        }

        const newVersion = Number(current.version) + 1;
        await client.query(
          `UPDATE app_users SET role = $2, status = 'active', version = $3, updated_at = CURRENT_TIMESTAMP
           WHERE email = $1`,
          [email, params.role, newVersion]
        );

        const eventResult = await client.query(
          `INSERT INTO app_user_access_events
           (user_email, action, actor_email, before_role, after_role, before_status, after_status)
           VALUES ($1, 're_enabled', $2, $3, $4, 'disabled', 'active')
           RETURNING *`,
          [email, actorEmail, current.role, params.role]
        );

        const user = await client.query(
          "SELECT * FROM app_users WHERE email = $1",
          [email]
        );

        return {
          ok: true,
          user: rowToUser(user.rows[0]),
          event: rowToEvent(eventResult.rows[0]),
        };
      });
    },

    async getSummaryCounts() {
      const result = await pool.query(`
        SELECT
          count(*) FILTER (WHERE status = 'pending') AS pending,
          count(*) FILTER (WHERE status = 'active') AS active,
          count(*) FILTER (WHERE status = 'disabled') AS disabled,
          count(*) FILTER (WHERE role = 'admin' AND status = 'active') AS admins
        FROM app_users
      `);
      const row = result.rows[0];
      return {
        pending: Number(row.pending),
        active: Number(row.active),
        disabled: Number(row.disabled),
        admins: Number(row.admins),
      };
    },
  };
}
