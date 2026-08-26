# Google Workspace Authentication and Production Authorization v1

**Status:** Approved for implementation  
**Scope:** CMP Pricing App production authentication, server-derived roles, and release of Additional Locations plus Admin Pricing

## Goal

Require verified Google Workspace authentication for the CMP Pricing App, derive authorization roles on the server, and safely enable Additional Locations and Admin Pricing in Vercel Production.

## Identity contract

- Provider: Google OAuth through stable `next-auth` v4.
- Session strategy: signed JWT cookie. No user database in v1.
- Allowed domain: `cmpsportswear.com`.
- Google profile must contain a verified email.
- Google `hd` is only an OAuth hint. Authorization must validate the verified email domain server-side.
- Initial Admin: `paul@cmpsportswear.com`.

## Role contract

Roles are resolved from normalized email addresses on every new JWT:

1. `admin` when email appears in `CMP_ADMIN_EMAILS`.
2. `manager` when email appears in `CMP_MANAGER_EMAILS`.
3. `sales_rep` for any other verified `@cmpsportswear.com` account.
4. No role and no sign-in for all other accounts.

CSV role lists are trimmed, lowercased, deduplicated, and exact-match only. Role changes require sign-out/sign-in in v1 because roles live in JWT sessions.

## Access contract

When `CMP_AUTH_ENABLED=true`:

- `/login`, `/unauthorized`, `/api/auth/**`, Next.js assets, and brand assets remain public.
- `/` and normal quote/catalog APIs require any authenticated CMP role.
- `/admin`, `/admin/**`, `/api/admin/**`, and `/concepts/**` require `admin` in v1.
- Unauthenticated API access returns 401 JSON from sensitive route guards.
- Authenticated but underprivileged API access returns 403 JSON.
- Page middleware redirects unauthenticated users to `/login` and underprivileged users to `/unauthorized`.
- Server route guards remain authoritative even if middleware is bypassed.

## Quote projection contract

- `sales_rep` receives Staff projections only.
- `manager` and `admin` receive Manager projections containing internal COGS and provenance.
- `x-cmp-role` is ignored whenever `CMP_AUTH_ENABLED=true`.
- Legacy local Manager mode remains available only when auth is disabled, `NODE_ENV` is non-production, and `CMP_ALLOW_LOCAL_MANAGER_MODE=true`.
- Protected Vercel Preview may retain its existing preview projection while app auth is disabled there.

## Production feature contract

Admin Pricing and Additional Locations may run in Vercel Production only when all are true:

- `CMP_AUTH_ENABLED=true`
- `CMP_ENABLE_AUTHENTICATED_PRODUCTION_FEATURES=true`
- The individual feature flag is true.

Individual flags:

- `CMP_ENABLE_PRICING_PREVIEW=true`
- `CMP_ENABLE_ADDITIONAL_LOCATIONS_PREVIEW=true`

Admin pages and Admin APIs additionally require the `admin` role. Additional Locations are visible to all authenticated users, but only Manager/Admin responses include internal COGS.

## Required environment variables

Production:

- `CMP_AUTH_ENABLED=true`
- `CMP_ALLOWED_GOOGLE_DOMAIN=cmpsportswear.com`
- `CMP_ADMIN_EMAILS=paul@cmpsportswear.com`
- `CMP_MANAGER_EMAILS=` (may be empty initially)
- `CMP_ENABLE_AUTHENTICATED_PRODUCTION_FEATURES=true`
- `CMP_ENABLE_PRICING_PREVIEW=true`
- `CMP_ENABLE_ADDITIONAL_LOCATIONS_PREVIEW=true`
- `GOOGLE_CLIENT_ID=<secret/config from Google Cloud>`
- `GOOGLE_CLIENT_SECRET=<secret from Google Cloud>`
- `NEXTAUTH_SECRET=<generated secret>`
- `NEXTAUTH_URL=https://cmp-pricing-app.vercel.app`

Authorized Google redirect URI:

- `https://cmp-pricing-app.vercel.app/api/auth/callback/google`

## UI contract

- Branded `/login` page with one Sign in with Google action.
- Clear domain restriction copy.
- Signed-in identity and role visible in application chrome.
- Sign-out action available.
- `/unauthorized` explains the role restriction and permits sign-out.
- Admin labels must stop calling the production surface a private preview when authenticated production mode is active. Session-only pricing controls must still be labeled session-only and non-persistent.

## Testing contract

Pure unit tests:

- Domain normalization and verified-email enforcement.
- Role precedence and exact matching.
- Missing/invalid env fail-closed behavior.
- Role capability checks.
- Production feature gates require auth plus explicit production enablement.

Route tests:

- Unauthenticated sensitive API: 401.
- Sales Rep quote: Staff shape and no costs/provenance.
- Manager/Admin quote: Manager shape.
- Spoofed role header cannot elevate an authenticated Sales Rep.
- Sales Rep/Manager Admin API: 403.
- Admin Admin API: success.
- Production feature flags without auth remain disabled.

Browser tests:

- Unauthenticated user reaches login.
- Non-CMP Google profile is rejected in callback-policy tests.
- Sales Rep sees Additional Locations but no COGS.
- Admin sees Additional Locations, COGS, `/admin`, and `/admin/pricing`.
- Sign-out returns to login.
- Existing unauthenticated local/E2E mode continues when auth flag is absent.

## Out of scope

- Database-managed users or role editing UI.
- Google Group synchronization.
- Persistent pricing drafts or publishing.
- Audit-event database.
- Customer accounts.
- Multi-tenant authorization.

## Release safety

1. Code and tests land behind `CMP_AUTH_ENABLED` and production feature flags.
2. Create Google OAuth credentials and configure Production secrets.
3. Deploy Preview with auth disabled and run standard regression checks.
4. Merge only after all checks and adversarial review pass.
5. Production deployment initially has authentication enabled.
6. Verify unauthenticated Production redirects before verifying authenticated content.
7. Verify Sales Rep and Admin projections separately where test identities are available.
8. If OAuth or authorization verification fails, disable `CMP_ENABLE_AUTHENTICATED_PRODUCTION_FEATURES` first, then investigate.
