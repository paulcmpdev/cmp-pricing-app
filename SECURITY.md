# Security and Evaluation Notes

## Current deployment posture

This application is for internal evaluation. The current stable Vercel URL is temporarily public for Paul's active testing. Do not share it broadly.

Manager mode is not authenticated. The client-controlled `x-cmp-role` header can request Manager responses containing internal COGS and margin data. This is an explicit blocker before broader sharing or production use.

Before broader access:

- add authenticated server-side sessions
- derive Staff/Manager authorization from trusted server context
- enable an account-supported deployment-protection method
- verify that Manager responses cannot be requested by Staff users
- review access logging and security headers

## Dependency audit

The baseline audit currently reports:

- full dependency tree: 3 moderate, 6 high, 1 critical
- production dependency tree: 2 high, 0 critical

The critical finding is in Vitest's optional development UI/server and is not shipped or started in production. Production findings are associated with the current Next.js/PostCSS dependency chain. Several advisories do not match this app's configuration because it has no rewrites, remote image patterns, or attacker-controlled CSS/source maps, but the dependency tree should not be described as clean.

A major Next.js upgrade must be handled as a dedicated, tested migration rather than an automatic `npm audit fix --force` change.

## Secret handling

The app requires no runtime credentials for current pricing behavior. Never commit `.env*`, `.vercel/`, API tokens, deployment bypass values, or authorization material.
