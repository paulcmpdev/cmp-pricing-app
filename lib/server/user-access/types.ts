/**
 * User Access types for the CMP admin access-control system.
 */

export type AppUserRole = "sales_rep" | "manager" | "admin";
export type AppUserStatus = "pending" | "active" | "disabled";

export interface AppUser {
  email: string;
  name: string | null;
  image: string | null;
  role: AppUserRole | null;
  status: AppUserStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
  lastSignInAt: string | null;
}

export type AccessEventAction =
  | "access_requested"
  | "approved"
  | "role_changed"
  | "disabled"
  | "re_enabled"
  | "pre_authorized";

export interface AppUserAccessEvent {
  id: string;
  userEmail: string;
  action: AccessEventAction;
  actorEmail: string;
  beforeRole: AppUserRole | null;
  afterRole: AppUserRole | null;
  beforeStatus: AppUserStatus | null;
  afterStatus: AppUserStatus | null;
  createdAt: string;
}

export type MutationOutcome<T = AppUser> =
  | { ok: true; user: T; event: AppUserAccessEvent }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "conflict"; message: string }
  | { ok: false; reason: "forbidden"; message: string }
  | { ok: false; reason: "unavailable"; message: string };

export interface UserAccessRepository {
  listUsers(): Promise<AppUser[]>;
  getUser(email: string): Promise<AppUser | null>;
  getUserEvents(email: string): Promise<AppUserAccessEvent[]>;
  requestAccess(params: {
    email: string;
    name: string | null;
    image: string | null;
  }): Promise<MutationOutcome>;
  preAuthorize(params: {
    email: string;
    role: AppUserRole;
    actorEmail: string;
  }): Promise<MutationOutcome>;
  approveUser(params: {
    email: string;
    role: AppUserRole;
    actorEmail: string;
    expectedVersion: number;
  }): Promise<MutationOutcome>;
  changeRole(params: {
    email: string;
    role: AppUserRole;
    actorEmail: string;
    expectedVersion: number;
  }): Promise<MutationOutcome>;
  disableUser(params: {
    email: string;
    actorEmail: string;
    expectedVersion: number;
  }): Promise<MutationOutcome>;
  reEnableUser(params: {
    email: string;
    role: AppUserRole;
    actorEmail: string;
    expectedVersion: number;
  }): Promise<MutationOutcome>;
  getSummaryCounts(): Promise<{
    pending: number;
    active: number;
    disabled: number;
    admins: number;
  }>;
}
