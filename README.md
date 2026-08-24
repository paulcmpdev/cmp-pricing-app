# CMP Pricing MVP

Local, greenfield pricing application for Compound Sportswear. The verified pricing packet and workbook-derived fixtures are the business-rule authority.

## Status

Local MVP only. **Do not deploy or share externally.** Manager mode is an evaluation convenience and is not authenticated.

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

## Deployment blocker

Manager mode currently uses the client-controlled `x-cmp-role` request header. This is deliberate for local evaluation, but it is **not authorization**. Any shared deployment must add authenticated server-side role enforcement and deployment protection before Manager responses can be exposed.

Do not deploy until Paul explicitly approves both the protection model and deployment.

## Source authority

Implementation packet:

`/Users/paulsanford/Downloads/CMP_Pricing_App_Claude_Packet`

The app must not silently reinterpret missing workbook rules. Unsupported controls remain deferred until parity coverage exists.
