# CMP Pricing MVP

Local, greenfield pricing application for Compound Sportswear. The verified pricing packet and workbook-derived fixtures are the business-rule authority.

## Status

Production-ready with Google Workspace authentication. When `CMP_AUTH_ENABLED=true`, all access requires a verified `@cmpsportswear.com` Google account. Server-derived roles (admin, manager, sales_rep) control quote projection visibility and admin access.

## Run locally

```bash
npm install
npm run dev
```

Open `http://localhost:3000/` for the primary Staff Quote Desk. The three evaluation interfaces remain available at `http://localhost:3000/concepts`.

Production-mode local check:

```bash
npm run build
npm start
```

## Interfaces

- `/` — primary Staff Quote Desk with vendor catalog first
- `/admin` — private read-only Catalog Operations preview
- `/concepts/quote-desk` — Quote Desk evaluation route with local Manager toggle
- `/concepts/guided-builder` — progressive Product → Quantity → Decoration → Review flow
- `/concepts/command-center` — dense manager-oriented dashboard and audit view

All interfaces call the same server quote endpoints and shared pricing engine.

## Verified pricing scope

Base item pricing is intentionally fixed to the packet's verified P0 configuration:

- DTF
- Average operating mode
- 10 × 10 transfer
- One included print location
- Tier Matrix
- T1

The app also implements live pooled DTF pricing for all nine flat-fee services, minimum billing at 12 pieces, editable labor controls, policy floors, manual overrides, margins, commission reserve, and contribution reporting.

## Commands

```bash
npm test
npm run test:e2e
npx tsc --noEmit
npm run lint
npm run build
```

Packet validation:

```bash
python3 /Users/paulsanford/Downloads/CMP_Pricing_App_Claude_Packet/source/validate_packet.py
```

## Architecture

- Next.js 14 App Router
- TypeScript strict mode
- Decimal.js for pricing arithmetic and half-up formatting
- Zod request validation
- Vitest pricing, parity, serialization, and helper tests
- Playwright interaction and viewport tests
- Server-only product-cost and internal-pricing modules

### Data boundary

Staff responses contain customer-facing quote outputs only. Raw product cost, wages, COGS, pooled policy, and manager internals remain server-side and are omitted from Staff responses and static browser bundles.

## Authentication and authorization

When `CMP_AUTH_ENABLED=true` (production):

- Google OAuth via `next-auth` v4 with JWT sessions. No user database.
- Only verified `@cmpsportswear.com` email addresses may sign in.
- Roles derived server-side from `CMP_ADMIN_EMAILS` and `CMP_MANAGER_EMAILS` env vars.
- `x-cmp-role` header is ignored; roles come exclusively from the JWT session.
- Sales reps see Staff quote projections only (no cost, COGS, wages, commission, or contribution data).
- Managers and admins see Manager projections with internal COGS and provenance.
- Admin pages (`/admin/**`) and admin APIs (`/api/admin/**`) require the admin role.
- Middleware redirects unauthenticated page requests to `/login`; API requests get 401 JSON.
- Server route guards remain authoritative even if middleware is bypassed.

When `CMP_AUTH_ENABLED` is absent (local dev, preview without auth):

- All pages and APIs are accessible without authentication.
- Legacy `x-cmp-role` header and `CMP_ALLOW_LOCAL_MANAGER_MODE` behavior is preserved.
- Protected Vercel Preview retains its existing preview projection behavior.

### Production feature flags

Admin Pricing and Additional Locations run in Vercel Production only when all are true:

- `CMP_AUTH_ENABLED=true`
- `CMP_ENABLE_AUTHENTICATED_PRODUCTION_FEATURES=true`
- The individual feature flag (`CMP_ENABLE_PRICING_PREVIEW`, `CMP_ENABLE_ADDITIONAL_LOCATIONS_PREVIEW`)

## Source authority

Implementation packet:

`/Users/paulsanford/Downloads/CMP_Pricing_App_Claude_Packet`

The app must not silently reinterpret missing workbook rules. Unsupported controls remain deferred until parity coverage exists.
