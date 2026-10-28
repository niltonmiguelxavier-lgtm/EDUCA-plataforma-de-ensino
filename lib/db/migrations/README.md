# Financial ledger model

This is an additive PostgreSQL migration and a Drizzle schema model. It creates tables and constraints only. It inserts no commission policy, wallet, payment, movement, withdrawal, or sample balance, and it does not configure a payment or payout provider.

## Model boundaries

- Amounts are exact NUMERIC(12,2) values in MZN. No wallet table has a balance column; bucket totals are derived from append-only ledger entries.
- Commission policies are effective-dated and append-only. There is no default rate. A confirmed payment must carry a policy ID, the rate in basis points, the captured amount, commission, and teacher net; those values are a historical snapshot.
- An expected payment amount is not evidence of receipt. Captured amounts are only valid together with a confirmed timestamp and a consistent commission/net split.
- Provider events store the provider event ID and a SHA-256 digest, not a raw webhook body or credential. A future provider integration must verify its signature and amount/currency before accepting an event.
- Withdrawal requests and their status events are records, not transfers. The payout destination field is for an opaque provider reference only, never a PIN or raw bank/mobile account data.
- Wallet operations group immutable credit/debit lines. The SQL migration blocks edits/deletes to audit rows and checks that bucket transfers balance within one database transaction.

## Apply deliberately

The migration is not applied by this change. Review it and take a database backup before applying it once to the intended database:

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f lib/db/migrations/0001_financial_ledger.sql

Do not enable paid reservations, display a positive wallet balance, or process a withdrawal until a real payment provider, server-side reconciliation, a configured commission policy, and an authorized payout process are implemented and tested. This repository change does not add those flows.
