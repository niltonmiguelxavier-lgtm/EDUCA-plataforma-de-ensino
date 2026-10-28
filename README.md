# EDUCA

EDUCA is an online learning platform for Mozambique. It connects students with approved teachers and supports teacher applications, online lesson scheduling, reviews, rankings and exam-preparation resources. The interface is in Portuguese and uses MZN for monetary values.

## Technology

- React, TypeScript, Vite and Tailwind CSS
- Express API with OpenAPI-generated client and validation schemas
- PostgreSQL with Drizzle ORM
- Clerk authentication managed through Replit

## Run

Use the Replit preview to run the project. The configured services are:

- `pnpm --filter @workspace/educa run dev` — EDUCA web app
- `pnpm --filter @workspace/api-server run dev` — shared API
- `pnpm run typecheck` — workspace type checks
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API clients after OpenAPI changes
- `pnpm --filter @workspace/db run push` — apply development database schema

## Environment

The app uses Replit-managed PostgreSQL and Clerk. Their environment values are supplied by Replit; do not copy them into source files. `SESSION_SECRET` is used to encrypt teacher identity numbers before they are stored in PostgreSQL.

## First administrator

1. Create an EDUCA account with the email address that should receive administrator access.
2. Verify that email through Clerk.
3. Run this command in the Replit shell, replacing the example with the verified account email:

   `pnpm --filter @workspace/api-server run bootstrap-admin -- admin@example.com`

The command verifies the account against Clerk, grants the first administrator role in the application database and records an audit entry. It will not promote a second account after an administrator already exists. Administrator privileges cannot be assigned through public registration or profile editing.

## Implemented in this first version

- Public home, teacher search and profiles, teacher rankings and exam-resource catalogue
- Clerk sign-in and sign-up
- Student profile and teacher application submission
- Administrator application queue, demonstration assessment scoring and approval/rejection decisions
- Approved-teacher lesson scheduling, student enrolment, lesson completion and eligible reviews
- Role-specific student, teacher and administrator dashboard summaries based on database records
- Encrypted storage of teacher identity numbers and server-side role checks

The database starts with subject categories and configurable server-side scoring defaults. It does not contain sample teachers, reviews or activity statistics.

## Not configured yet

Video conferencing, payment providers (including M-Pesa and e-Mola), outbound email, document storage and course/material administration require external service configuration and are not represented as working integrations. Until a verified payment flow is integrated, the API and interface block bookings for paid lessons; free lessons remain available. Exam resources are only shown after an administrator publishes and cites their sources. The first version does not yet include full notification delivery, configurable ranking controls in the admin UI, or complete audit-history browsing.
