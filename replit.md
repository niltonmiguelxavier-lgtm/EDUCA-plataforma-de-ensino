# EDUCA

EDUCA connects students and approved teachers in Mozambique through lessons, applications, learning resources and exam preparation.

## Run & Operate

- `pnpm --filter @workspace/educa run dev` — run the EDUCA web app
- `pnpm --filter @workspace/api-server run dev` — run the shared API server
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Replit supplies `DATABASE_URL`, Clerk keys and `SESSION_SECRET`.

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/educa` — EDUCA React/Vite interface and branded Clerk pages
- `artifacts/api-server` — Express API, authorization and application/lesson flows
- `lib/api-spec/openapi.yaml` — API contract source of truth
- `lib/db/src/schema/educa.ts` — PostgreSQL schema
- `README.md` — run instructions, initial admin setup and integration boundaries

## Architecture decisions

- Clerk handles authentication; EDUCA roles and approval states are stored and enforced by the API.
- Teachers can schedule lessons only after explicit administrator approval; suspension blocks teaching through server checks.
- Teacher identity numbers are encrypted at rest using a key derived from `SESSION_SECRET`.
- Ratings and rankings use stored reviews and lesson records; no sample teachers or activity statistics are seeded.
- Video, payment and outbound email integrations remain disabled until configured.

## Product

The first version supports public teacher discovery, student profiles, teacher applications, administrator demonstration assessments and decisions, lesson scheduling and enrolment, eligible student reviews, server-calculated rankings, and published exam resources.

## User preferences

- Use Portuguese (Portugal) understandable in Mozambique and MZN.
- Keep the interface responsive and mobile-friendly.
- Public platform totals must come from database records; do not invent activity or teacher data.

## Gotchas

- Regenerate API clients after changing `lib/api-spec/openapi.yaml`.
- The initial administrator is granted with the verified-account bootstrap command in `README.md`; public registration cannot assign roles.
- Do not expose or log encrypted teacher identity data outside administrator-authorized application review.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
