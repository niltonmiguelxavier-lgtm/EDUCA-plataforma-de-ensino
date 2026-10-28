import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { educaUsers, lessonEnrollments, lessons } from "./educa";

// Financial states describe records only; no provider or payout is enabled by these tables.
export const lessonPaymentStatusEnum = pgEnum("lesson_payment_status", [
  "pending",
  "processing",
  "confirmed",
  "failed",
  "cancelled",
  "refund_pending",
  "refunded",
]);
export const paymentProviderEventResultEnum = pgEnum("payment_provider_event_result", [
  "unmatched",
  "rejected",
  "accepted",
  "duplicate",
]);
export const teacherWalletBucketEnum = pgEnum("teacher_wallet_bucket", [
  "pending",
  "available",
  "reserved",
]);
export const walletMovementTypeEnum = pgEnum("wallet_movement_type", [
  "lesson_credit",
  "pending_release",
  "withdrawal_reserve",
  "withdrawal_release",
  "withdrawal_settlement",
  "refund",
  "adjustment",
  "reversal",
]);
export const walletEntryDirectionEnum = pgEnum("wallet_entry_direction", [
  "credit",
  "debit",
]);
export const withdrawalRequestStatusEnum = pgEnum("withdrawal_request_status", [
  "requested",
  "in_review",
  "approved",
  "processing",
  "completed",
  "rejected",
  "failed",
  "cancelled",
]);

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

// Empty until an administrator deliberately configures a rate. Policies are effective-dated;
// payment rows snapshot the selected policy and basis-point rate at confirmation time.
export const commissionPolicies = pgTable(
  "commission_policies",
  {
    id: text("id").primaryKey(),
    teacherId: text("teacher_id").references(() => educaUsers.id, {
      onDelete: "restrict",
    }),
    rateBasisPoints: integer("rate_basis_points").notNull(),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull(),
    effectiveUntil: timestamp("effective_until", { withTimezone: true }),
    reason: text("reason").notNull(),
    createdBy: text("created_by")
      .notNull()
      .references(() => educaUsers.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
  },
  (table) => [
    check(
      "commission_policies_rate_range",
      sql.raw("rate_basis_points between 0 and 10000"),
    ),
    check(
      "commission_policies_date_range",
      sql.raw("effective_until is null or effective_until > effective_from"),
    ),
    uniqueIndex("commission_policies_global_effective_idx")
      .on(table.effectiveFrom)
      .where(sql.raw("teacher_id is null")),
    uniqueIndex("commission_policies_teacher_effective_idx")
      .on(table.teacherId, table.effectiveFrom)
      .where(sql.raw("teacher_id is not null")),
    index("commission_policies_teacher_effective_lookup_idx").on(
      table.teacherId,
      table.effectiveFrom,
    ),
  ],
);

// Captured amounts and commission snapshots remain null until a verified provider event is
// reconciled. Expected amounts are not evidence of money received.
export const lessonPayments = pgTable(
  "lesson_payments",
  {
    id: text("id").primaryKey(),
    enrollmentId: text("enrollment_id")
      .notNull()
      .references(() => lessonEnrollments.id, { onDelete: "restrict" }),
    lessonId: text("lesson_id")
      .notNull()
      .references(() => lessons.id, { onDelete: "restrict" }),
    studentId: text("student_id")
      .notNull()
      .references(() => educaUsers.id, { onDelete: "restrict" }),
    teacherId: text("teacher_id")
      .notNull()
      .references(() => educaUsers.id, { onDelete: "restrict" }),
    providerCode: text("provider_code").notNull(),
    providerTransactionId: text("provider_transaction_id"),
    idempotencyKey: text("idempotency_key").notNull(),
    expectedAmountMzn: numeric("expected_amount_mzn", { precision: 12, scale: 2 })
      .notNull(),
    capturedAmountMzn: numeric("captured_amount_mzn", { precision: 12, scale: 2 }),
    currency: text("currency").notNull().default("MZN"),
    commissionPolicyId: text("commission_policy_id").references(
      () => commissionPolicies.id,
      { onDelete: "restrict" },
    ),
    commissionRateBasisPoints: integer("commission_rate_basis_points"),
    commissionAmountMzn: numeric("commission_amount_mzn", {
      precision: 12,
      scale: 2,
    }),
    teacherNetAmountMzn: numeric("teacher_net_amount_mzn", {
      precision: 12,
      scale: 2,
    }),
    status: lessonPaymentStatusEnum("status").notNull().default("pending"),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    failureCode: text("failure_code"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("lesson_payments_idempotency_key_idx").on(table.idempotencyKey),
    uniqueIndex("lesson_payments_provider_transaction_idx")
      .on(table.providerCode, table.providerTransactionId)
      .where(sql.raw("provider_transaction_id is not null")),
    index("lesson_payments_enrollment_created_idx").on(
      table.enrollmentId,
      table.createdAt,
    ),
    index("lesson_payments_teacher_status_idx").on(table.teacherId, table.status),
    index("lesson_payments_student_created_idx").on(
      table.studentId,
      table.createdAt,
    ),
    check(
      "lesson_payments_expected_amount_positive",
      sql.raw("expected_amount_mzn > 0"),
    ),
    check(
      "lesson_payments_snapshot_consistent",
      sql.raw(
        "((captured_amount_mzn is null and commission_policy_id is null and commission_rate_basis_points is null and commission_amount_mzn is null and teacher_net_amount_mzn is null) or (captured_amount_mzn is not null and captured_amount_mzn = expected_amount_mzn and commission_policy_id is not null and commission_rate_basis_points is not null and commission_rate_basis_points between 0 and 10000 and commission_amount_mzn is not null and commission_amount_mzn >= 0 and teacher_net_amount_mzn is not null and teacher_net_amount_mzn >= 0 and commission_amount_mzn + teacher_net_amount_mzn = captured_amount_mzn))",
      ),
    ),
    check(
      "lesson_payments_confirmed_has_snapshot",
      sql.raw(
        "((status in ('confirmed', 'refund_pending', 'refunded') and confirmed_at is not null and captured_amount_mzn is not null) or (status not in ('confirmed', 'refund_pending', 'refunded') and confirmed_at is null and captured_amount_mzn is null))",
      ),
    ),
  ],
);

// Store provider event identity and a digest only, never the raw webhook body or credentials.
export const paymentProviderEvents = pgTable(
  "payment_provider_events",
  {
    id: text("id").primaryKey(),
    paymentId: text("payment_id").references(() => lessonPayments.id, {
      onDelete: "restrict",
    }),
    providerCode: text("provider_code").notNull(),
    providerEventId: text("provider_event_id").notNull(),
    eventType: text("event_type").notNull(),
    payloadSha256: text("payload_sha256").notNull(),
    signatureVerified: boolean("signature_verified").notNull().default(false),
    processingResult: paymentProviderEventResultEnum("processing_result")
      .notNull()
      .default("unmatched"),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("payment_provider_events_provider_event_idx").on(
      table.providerCode,
      table.providerEventId,
    ),
    index("payment_provider_events_payment_received_idx").on(
      table.paymentId,
      table.receivedAt,
    ),
    check(
      "payment_provider_events_accepted_verified",
      sql.raw("processing_result <> 'accepted' or signature_verified = true"),
    ),
  ],
);

// This row is a lockable wallet identity, not a stored or seeded balance.
export const teacherWallets = pgTable(
  "teacher_wallets",
  {
    id: text("id").primaryKey(),
    teacherId: text("teacher_id")
      .notNull()
      .references(() => educaUsers.id, { onDelete: "restrict" })
      .unique(),
    currency: text("currency").notNull().default("MZN"),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("teacher_wallets_id_owner_idx").on(table.id, table.teacherId),
  ],
);

export const withdrawalRequests = pgTable(
  "withdrawal_requests",
  {
    id: text("id").primaryKey(),
    reference: text("reference").notNull().unique(),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    walletId: text("wallet_id").notNull(),
    teacherId: text("teacher_id")
      .notNull()
      .references(() => educaUsers.id, { onDelete: "restrict" }),
    amountMzn: numeric("amount_mzn", { precision: 12, scale: 2 }).notNull(),
    currency: text("currency").notNull().default("MZN"),
    payoutMethodCode: text("payout_method_code").notNull(),
    // Opaque provider reference only; never put a mobile PIN or raw bank details here.
    payoutDestinationRef: text("payout_destination_ref"),
    status: withdrawalRequestStatusEnum("status")
      .notNull()
      .default("requested"),
    requestedAt: timestamp("requested_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    reviewedBy: text("reviewed_by").references(() => educaUsers.id, {
      onDelete: "restrict",
    }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewNote: text("review_note"),
    payoutProviderReference: text("payout_provider_reference"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    foreignKey({
      columns: [table.walletId, table.teacherId],
      foreignColumns: [teacherWallets.id, teacherWallets.teacherId],
      name: "withdrawal_requests_wallet_owner_fk",
    }).onDelete("restrict"),
    index("withdrawal_requests_teacher_status_idx").on(
      table.teacherId,
      table.status,
      table.createdAt,
    ),
    uniqueIndex("withdrawal_requests_payout_reference_idx")
      .on(table.payoutProviderReference)
      .where(sql.raw("payout_provider_reference is not null")),
    check("withdrawal_requests_amount_positive", sql.raw("amount_mzn > 0")),
    check(
      "withdrawal_requests_completed_has_reference",
      sql.raw("status <> 'completed' or (completed_at is not null and payout_provider_reference is not null)"),
    ),
  ],
);

// Mutable request state is paired with immutable events so review/processing decisions remain traceable.
export const withdrawalRequestEvents = pgTable(
  "withdrawal_request_events",
  {
    id: text("id").primaryKey(),
    withdrawalRequestId: text("withdrawal_request_id")
      .notNull()
      .references(() => withdrawalRequests.id, { onDelete: "restrict" }),
    status: withdrawalRequestStatusEnum("status").notNull(),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    actorId: text("actor_id").references(() => educaUsers.id, {
      onDelete: "restrict",
    }),
    note: text("note"),
    providerReference: text("provider_reference"),
    createdAt: createdAt(),
  },
  (table) => [
    index("withdrawal_request_events_request_created_idx").on(
      table.withdrawalRequestId,
      table.createdAt,
    ),
  ],
);

// Wallet balances are derived from these immutable entries; never cache them on teacher_wallets.
export const walletLedgerOperations = pgTable(
  "wallet_ledger_operations",
  {
    id: text("id").primaryKey(),
    walletId: text("wallet_id")
      .notNull()
      .references(() => teacherWallets.id, { onDelete: "restrict" }),
    paymentId: text("payment_id").references(() => lessonPayments.id, {
      onDelete: "restrict",
    }),
    withdrawalRequestId: text("withdrawal_request_id").references(
      () => withdrawalRequests.id,
      { onDelete: "restrict" },
    ),
    reversalOfOperationId: text("reversal_of_operation_id").references(
      (): AnyPgColumn => walletLedgerOperations.id,
      { onDelete: "restrict" },
    ),
    operationType: walletMovementTypeEnum("operation_type").notNull(),
    reference: text("reference").notNull().unique(),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    reason: text("reason").notNull(),
    createdBy: text("created_by").references(() => educaUsers.id, {
      onDelete: "restrict",
    }),
    createdAt: createdAt(),
  },
  (table) => [
    index("wallet_ledger_operations_wallet_created_idx").on(
      table.walletId,
      table.createdAt,
    ),
    index("wallet_ledger_operations_payment_idx").on(table.paymentId),
    index("wallet_ledger_operations_withdrawal_idx").on(
      table.withdrawalRequestId,
    ),
    uniqueIndex("wallet_ledger_lesson_credit_once_idx")
      .on(table.paymentId)
      .where(sql.raw("payment_id is not null and operation_type = 'lesson_credit'")),
    uniqueIndex("wallet_ledger_withdrawal_reserve_once_idx")
      .on(table.withdrawalRequestId)
      .where(sql.raw("withdrawal_request_id is not null and operation_type = 'withdrawal_reserve'")),
    check(
      "wallet_ledger_operation_source_matches_type",
      sql.raw(
        "((operation_type in ('lesson_credit', 'pending_release', 'refund') and payment_id is not null and withdrawal_request_id is null) or (operation_type in ('withdrawal_reserve', 'withdrawal_release', 'withdrawal_settlement') and withdrawal_request_id is not null and payment_id is null) or (operation_type = 'adjustment' and payment_id is null and withdrawal_request_id is null and created_by is not null) or (operation_type = 'reversal' and reversal_of_operation_id is not null and payment_id is null and withdrawal_request_id is null))",
      ),
    ),
  ],
);

export const walletLedgerEntries = pgTable(
  "wallet_ledger_entries",
  {
    id: text("id").primaryKey(),
    operationId: text("operation_id")
      .notNull()
      .references(() => walletLedgerOperations.id, { onDelete: "restrict" }),
    bucket: teacherWalletBucketEnum("bucket").notNull(),
    direction: walletEntryDirectionEnum("direction").notNull(),
    amountMzn: numeric("amount_mzn", { precision: 12, scale: 2 }).notNull(),
    reversalOfEntryId: text("reversal_of_entry_id").references(
      (): AnyPgColumn => walletLedgerEntries.id,
      { onDelete: "restrict" },
    ),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("wallet_ledger_entries_operation_bucket_direction_idx").on(
      table.operationId,
      table.bucket,
      table.direction,
    ),
    index("wallet_ledger_entries_operation_idx").on(table.operationId),
    check("wallet_ledger_entries_amount_positive", sql.raw("amount_mzn > 0")),
  ],
);
