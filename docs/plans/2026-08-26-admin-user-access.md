# Admin Users & Access Implementation Plan

> **For Hermes:** Use the Watson multi-agent delivery workflow. Claude implements; Codex reviews; Watson verifies.

**Goal:** Add an Admin Users & Access feature where new verified CMP Google accounts remain pending until an Admin grants Sales Rep, Manager, or Admin access, with immediate server-side enforcement and an immutable audit trail.

**Architecture:** Add a feature-gated PostgreSQL access-control repository using the existing pooled CMP database connection (`CMP_DATABASE_URL`, falling back to `VENDOR_CATALOG_DATABASE_URL`). JWTs retain identity and a display role, but protected server pages and APIs re-resolve active access from PostgreSQL so role changes and suspensions take effect immediately. Environment-configured Admin emails remain emergency bootstrap Admins and cannot be modified through the UI.

**Tech Stack:** Next.js 16.3.3, NextAuth v4 JWT identity, PostgreSQL via `pg`, React 18, Tailwind, Vitest, Playwright.

---

## Product contract

### Roles

- `sales_rep`: Quote Desk and Additional Locations; staff-safe API projection.
- `manager`: Sales Rep access plus internal COGS/provenance; no Admin routes.
- `admin`: Manager access plus all Admin pages and access-management APIs.

### Access states

- `pending`: verified CMP identity requested access but has no app session/access.
- `active`: role is enforced from PostgreSQL.
- `disabled`: sign-in and all protected routes are denied.

### First-sign-in behavior

- Exact verified `@cmpsportswear.com` identity is required.
- Unknown identity is inserted idempotently as `pending`, an audit event is appended, and sign-in redirects to a public Pending Access page.
- Pending and disabled identities do not receive an authorized app session.
- Bootstrap Admin emails from `CMP_ADMIN_EMAILS` retain Admin access even when the access database is unavailable.

### Safety rules

- Feature remains behind `CMP_USER_ACCESS_ENABLED=true`; when absent, current environment-role behavior is preserved.
- Bootstrap Admins cannot be changed or disabled through the API.
- The final active database Admin cannot be demoted or disabled.
- Mutations require Admin authorization, expected row version, transaction-level locking, and post-write read-back.
- Every access change appends an audit event containing actor, before/after role/status, action, and timestamp.
- No Production migration, feature flag, or deployment in this implementation PR.

### UI

- Add `/admin/users` and an Admin Header navigation link named `Users & Access`.
- Summary cards: Pending, Active, Disabled, Admins.
- User list/table with search and status filter.
- Pending request approval requires selecting a role.
- Active users support role change and disable.
- Disabled users support re-enable with an explicit role.
- Bootstrap Admin rows are visibly locked.
- Mutations use an explicit confirmation surface and show success/error feedback.
- Mobile layout must become stacked cards rather than a horizontally crushed table.
- Dark gray CMP admin palette; pure black/white reserved for high-emphasis controls and text.

---

### Task 1: Add access schema and migration command

**Files:**
- Create: `lib/server/user-access/postgres-schema.ts`
- Create: `scripts/migrate-user-access.mjs`
- Modify: `package.json`
- Test: `lib/server/user-access/__tests__/postgres-schema.test.ts`
- Test: `lib/server/user-access/__tests__/postgres-integration.test.ts`

**Steps:**
1. Write failing schema contract tests.
2. Define `app_users` with normalized lowercase email primary key, nullable role constrained to three roles, status constrained to pending/active/disabled, name/image fields, `version >= 1`, timestamps, and last sign-in.
3. Define append-only `app_user_access_events` with UUID primary key and before/after role/status fields.
4. Add useful indexes for status/update ordering and user audit history.
5. Add `npm run access:migrate`; require an explicit database URL and print no credentials.
6. Prove idempotent migration and append-only audit behavior in PostgreSQL integration tests.

### Task 2: Build repository and mutation invariants

**Files:**
- Create: `lib/server/user-access/types.ts`
- Create: `lib/server/user-access/repository.ts`
- Create: `lib/server/user-access/postgres-repository.ts`
- Test: `lib/server/user-access/__tests__/repository.test.ts`
- Test: `lib/server/user-access/__tests__/postgres-repository.test.ts`

**Steps:**
1. Write failing tests for normalization, list/get, idempotent pending request, pre-authorization, role update, disable/re-enable, optimistic version failure, bootstrap lock, and final-admin protection.
2. Add a reusable server-only PostgreSQL pool using `CMP_DATABASE_URL ?? VENDOR_CATALOG_DATABASE_URL`, max 2 connections, 5s connection timeout, and 30s idle timeout.
3. Implement pure repository interfaces so auth and route tests can inject fakes.
4. Implement writes as transactions with `SELECT ... FOR UPDATE`, exact expected version matching, audit insert, update, and authoritative read-back.
5. Return structured unavailable/conflict/forbidden/not-found outcomes; never collapse a possibly applied write into generic success.

### Task 3: Integrate pending approval with authentication

**Files:**
- Modify: `lib/server/auth/policy.ts`
- Modify: `lib/server/auth/auth-options.ts`
- Modify: `lib/server/auth/route-guards.ts`
- Modify: `proxy.ts`
- Create: `lib/server/auth/access-resolution.ts`
- Create: `app/pending-access/page.tsx`
- Modify: auth tests under `lib/server/auth/__tests__/`

**Steps:**
1. Write failing tests for the disabled feature fallback, bootstrap Admin access, unknown-user pending creation, active database role resolution, pending/disabled denial, database-unavailable fail-closed behavior, and immediate role-change enforcement.
2. Add `CMP_USER_ACCESS_ENABLED` gate.
3. Keep Google exact-domain and verified-email checks.
4. When enabled, upsert unknown verified users as pending and route them to Pending Access; do not create an authorized session.
5. Make route guards and quote projection re-resolve access by normalized email from PostgreSQL; never trust a stale JWT role as authoritative when the feature is enabled.
6. Add authoritative server-page checks for Quote Desk and Admin layouts so stale JWTs cannot preserve page access.
7. Keep Proxy as a coarse UX boundary only; server pages and APIs remain authoritative.

### Task 4: Add Admin user APIs

**Files:**
- Create: `app/api/admin/users/route.ts`
- Create: `app/api/admin/users/[email]/route.ts`
- Create: route tests beside each route.

**Steps:**
1. Write failing tests for Admin-only GET/POST/PATCH, malformed emails, non-CMP emails, invalid roles/status, stale versions, bootstrap lock, final-admin prevention, and database errors.
2. `GET` returns users plus bootstrap Admin projections and summary counts without secrets.
3. `POST` pre-authorizes a CMP email as active with a selected role.
4. `PATCH` accepts exactly one approved transition payload plus `expectedVersion`.
5. Re-read and return the authoritative user and audit result after each mutation.

### Task 5: Build Users & Access UI

**Files:**
- Create: `app/admin/users/page.tsx`
- Create: `app/admin/users/_components/UserAccessDashboard.tsx`
- Create: focused child components as needed under the same directory.
- Modify: `app/admin/_components/AdminHeader.tsx`
- Add component tests.

**Steps:**
1. Build server-rendered initial data with explicit unavailable/empty/error states.
2. Add Pending/Active/Disabled/Admin summary cards.
3. Add search and status filters.
4. Add role/status actions with expected version and explicit confirmation.
5. Preserve keyboard navigation, visible focus, semantic labels, minimum 44px touch targets, and screen-reader status feedback.
6. Verify desktop table and mobile stacked-card layout at 1440, 768, and 390 widths.

### Task 6: Extend authenticated browser tests

**Files:**
- Modify: `tests/auth-e2e/authenticated-production.spec.ts`
- Modify: `playwright.auth.config.ts` only if required for an injected test repository.

**Steps:**
1. Cover pending-user denial and Pending Access page.
2. Cover Admin list, approval, role change, disable, re-enable, and audit feedback.
3. Cover Manager/Sales Rep denial from `/admin/users` and Admin APIs.
4. Cover immediate server denial after a user is disabled despite a previously signed JWT.
5. Preserve existing ordinary and authenticated browser suites.

### Task 7: Verification and delivery

1. Run targeted Vitest tests and prove at least one critical regression test fails when the access check is sabotaged.
2. Run `npm test`.
3. Run `npx tsc --noEmit`.
4. Run `npm run lint`.
5. Run `npm run build`.
6. Run `npm run test:e2e`.
7. Run `npm run test:e2e:auth`.
8. Run `npm audit --omit=dev` and `git diff --check`.
9. Run independent Codex security/correctness review; fix every blocking/high/medium finding.
10. Watson reviews the complete diff and visually verifies desktop/mobile UI locally.
11. Commit, push, and open a PR. Verify the PR head, file list, CI, and protected Vercel Preview.
12. Stop before any Production migration, flag enablement, or deployment. Prepare an explicit release preview and rollback plan for Paul.
