import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const educaRoleEnum = pgEnum("educa_role", ["student", "teacher", "admin"]);
export const applicationStatusEnum = pgEnum("teacher_application_status", [
  "pending",
  "scheduled",
  "in_review",
  "approved",
  "rejected",
  "suspended",
]);
export const lessonStatusEnum = pgEnum("lesson_status", [
  "scheduled",
  "in_progress",
  "completed",
  "cancelled",
]);
export const lessonModalityEnum = pgEnum("lesson_modality", ["individual", "group"]);
export const enrollmentStatusEnum = pgEnum("enrollment_status", [
  "enrolled",
  "attended",
  "absent",
  "cancelled",
]);
export const examResourceTypeEnum = pgEnum("exam_resource_type", [
  "exercise",
  "test",
  "material",
  "lesson",
]);

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

export const educaUsers = pgTable(
  "educa_users",
  {
    id: text("id").primaryKey(),
    email: text("email"),
    name: text("name"),
    role: educaRoleEnum("role").notNull().default("student"),
    phone: text("phone"),
    level: text("level"),
    interests: text("interests").array().notNull().default(sql`'{}'::text[]`),
    ...timestamps,
  },
  (table) => [
    index("educa_users_role_idx").on(table.role),
    index("educa_users_email_idx").on(table.email),
  ],
);

export const subjects = pgTable(
  "subjects",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull().unique(),
    levels: text("levels").array().notNull().default(sql`'{}'::text[]`),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (table) => [index("subjects_active_name_idx").on(table.isActive, table.name)],
);

export const teacherApplications = pgTable(
  "teacher_applications",
  {
    id: text("id").primaryKey(),
    applicantId: text("applicant_id")
      .notNull()
      .references(() => educaUsers.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    email: text("email"),
    phone: text("phone").notNull(),
    // The BI is encrypted before it reaches PostgreSQL and is only decrypted
    // inside an administrator-authorized handler.
    identityNumberEncrypted: text("identity_number_encrypted").notNull(),
    bio: text("bio").notNull(),
    subjects: text("subjects").array().notNull().default(sql`'{}'::text[]`),
    levels: text("levels").array().notNull().default(sql`'{}'::text[]`),
    experience: text("experience"),
    availability: text("availability"),
    photoUrl: text("photo_url"),
    status: applicationStatusEnum("status").notNull().default("pending"),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    assessmentScore: numeric("assessment_score", { precision: 5, scale: 2 }),
    decisionNotes: text("decision_notes"),
    ...timestamps,
  },
  (table) => [
    index("teacher_applications_status_created_idx").on(table.status, table.createdAt),
    index("teacher_applications_applicant_idx").on(table.applicantId),
    uniqueIndex("teacher_applications_active_applicant_idx")
      .on(table.applicantId)
      .where(sql`${table.status} <> 'rejected'`),
  ],
);

export const teacherProfiles = pgTable(
  "teacher_profiles",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => educaUsers.id, { onDelete: "cascade" }),
    bio: text("bio").notNull().default(""),
    photoUrl: text("photo_url"),
    subjects: text("subjects").array().notNull().default(sql`'{}'::text[]`),
    levels: text("levels").array().notNull().default(sql`'{}'::text[]`),
    availability: text("availability"),
    hourlyRateMzn: numeric("hourly_rate_mzn", { precision: 10, scale: 2 }),
    modalities: text("modalities")
      .array()
      .notNull()
      .default(sql`ARRAY['individual']::text[]`),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (table) => [
    index("teacher_profiles_active_idx").on(table.isActive),
    index("teacher_profiles_subjects_idx").using("gin", table.subjects),
  ],
);

export const demoAssessments = pgTable(
  "teacher_demo_assessments",
  {
    id: text("id").primaryKey(),
    applicationId: text("application_id")
      .notNull()
      .references(() => teacherApplications.id, { onDelete: "cascade" }),
    evaluatorId: text("evaluator_id")
      .notNull()
      .references(() => educaUsers.id, { onDelete: "restrict" }),
    subjectMastery: integer("subject_mastery").notNull(),
    clarity: integer("clarity").notNull(),
    organization: integer("organization").notNull(),
    questionHandling: integer("question_handling").notNull(),
    communication: integer("communication").notNull(),
    totalScore: integer("total_score").notNull(),
    percentage: numeric("percentage", { precision: 5, scale: 2 }).notNull(),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("teacher_demo_assessments_application_idx").on(table.applicationId, table.createdAt),
    check(
      "teacher_demo_assessments_scores_range",
      sql`${table.subjectMastery} between 1 and 5
        and ${table.clarity} between 1 and 5
        and ${table.organization} between 1 and 5
        and ${table.questionHandling} between 1 and 5
        and ${table.communication} between 1 and 5`,
    ),
  ],
);

export const lessons = pgTable(
  "lessons",
  {
    id: text("id").primaryKey(),
    teacherId: text("teacher_id")
      .notNull()
      .references(() => educaUsers.id, { onDelete: "restrict" }),
    subject: text("subject").notNull(),
    level: text("level").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    durationMinutes: integer("duration_minutes").notNull(),
    capacity: integer("capacity").notNull(),
    modality: lessonModalityEnum("modality").notNull(),
    hourlyRateMzn: numeric("hourly_rate_mzn", { precision: 10, scale: 2 }),
    status: lessonStatusEnum("status").notNull().default("scheduled"),
    meetingUrl: text("meeting_url"),
    ...timestamps,
  },
  (table) => [
    index("lessons_teacher_start_idx").on(table.teacherId, table.startsAt),
    index("lessons_status_start_idx").on(table.status, table.startsAt),
    check("lessons_duration_range", sql`${table.durationMinutes} between 15 and 240`),
    check("lessons_capacity_range", sql`${table.capacity} between 1 and 100`),
  ],
);

export const lessonEnrollments = pgTable(
  "lesson_enrollments",
  {
    id: text("id").primaryKey(),
    lessonId: text("lesson_id")
      .notNull()
      .references(() => lessons.id, { onDelete: "cascade" }),
    studentId: text("student_id")
      .notNull()
      .references(() => educaUsers.id, { onDelete: "cascade" }),
    status: enrollmentStatusEnum("status").notNull().default("enrolled"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("lesson_enrollments_unique_student_lesson").on(
      table.lessonId,
      table.studentId,
    ),
    index("lesson_enrollments_student_idx").on(table.studentId, table.status),
  ],
);

export const lessonReviews = pgTable(
  "lesson_reviews",
  {
    id: text("id").primaryKey(),
    lessonId: text("lesson_id")
      .notNull()
      .references(() => lessons.id, { onDelete: "cascade" }),
    studentId: text("student_id")
      .notNull()
      .references(() => educaUsers.id, { onDelete: "restrict" }),
    teacherId: text("teacher_id")
      .notNull()
      .references(() => educaUsers.id, { onDelete: "restrict" }),
    stars: integer("stars").notNull(),
    clarity: boolean("clarity"),
    helpful: boolean("helpful"),
    recommend: boolean("recommend"),
    comment: text("comment"),
    isVisible: boolean("is_visible").notNull().default(true),
    isFlagged: boolean("is_flagged").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("lesson_reviews_once_per_student_lesson").on(
      table.lessonId,
      table.studentId,
    ),
    index("lesson_reviews_teacher_visibility_idx").on(table.teacherId, table.isVisible),
    check("lesson_reviews_stars_range", sql`${table.stars} between 1 and 5`),
  ],
);

export const examResources = pgTable(
  "exam_resources",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    institution: text("institution"),
    exam: text("exam"),
    subject: text("subject").notNull(),
    level: text("level").notNull(),
    topic: text("topic"),
    resourceType: examResourceTypeEnum("resource_type").notNull(),
    description: text("description"),
    source: text("source"),
    url: text("url"),
    isPublished: boolean("is_published").notNull().default(false),
    createdBy: text("created_by").references(() => educaUsers.id, {
      onDelete: "set null",
    }),
    ...timestamps,
  },
  (table) => [
    index("exam_resources_published_subject_idx").on(
      table.isPublished,
      table.subject,
      table.level,
    ),
  ],
);

export const platformSettings = pgTable("platform_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  ...timestamps,
});

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: text("id").primaryKey(),
    actorId: text("actor_id")
      .notNull()
      .references(() => educaUsers.id, { onDelete: "restrict" }),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    details: jsonb("details").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("audit_logs_entity_created_idx").on(
      table.entityType,
      table.entityId,
      table.createdAt,
    ),
    index("audit_logs_actor_created_idx").on(table.actorId, table.createdAt),
  ],
);

// ---------------------------------------------------------------------------
// Fase 2 — pagamentos, carteira interna, notificações e denúncias.
// Todos os valores monetários estão em MZN por defeito (numeric, nunca float).
// Nada aqui marca um pagamento como pago: apenas o backend, depois da
// confirmação assinada do fornecedor, pode mudar o estado para "confirmed".
// ---------------------------------------------------------------------------

export const paymentMethodEnum = pgEnum("payment_method", ["mpesa", "emola", "other"]);
export const paymentStatusEnum = pgEnum("payment_status", [
  "pending",
  "confirmed",
  "failed",
  "cancelled",
  "refunded",
]);
export const refundStatusEnum = pgEnum("refund_status", [
  "requested",
  "approved",
  "rejected",
  "processed",
]);
export const walletEntryTypeEnum = pgEnum("wallet_entry_type", [
  "sale",
  "commission",
  "release",
  "refund",
  "adjustment",
  "withdrawal",
]);
export const walletBucketEnum = pgEnum("wallet_bucket", ["pending", "available"]);
export const withdrawalStatusEnum = pgEnum("withdrawal_status", [
  "requested",
  "approved",
  "paid",
  "rejected",
  "cancelled",
]);
export const reportStatusEnum = pgEnum("report_status", ["open", "in_review", "resolved", "dismissed"]);

export const payments = pgTable(
  "payments",
  {
    id: text("id").primaryKey(),
    // Referência única gerada pela EDUCA e enviada ao fornecedor.
    reference: text("reference").notNull(),
    enrollmentId: text("enrollment_id")
      .notNull()
      .references(() => lessonEnrollments.id, { onDelete: "restrict" }),
    studentId: text("student_id")
      .notNull()
      .references(() => educaUsers.id, { onDelete: "restrict" }),
    teacherId: text("teacher_id")
      .notNull()
      .references(() => educaUsers.id, { onDelete: "restrict" }),
    amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
    currency: text("currency").notNull().default("MZN"),
    // Comissão calculada no servidor no momento da confirmação.
    commissionAmount: numeric("commission_amount", { precision: 12, scale: 2 }),
    method: paymentMethodEnum("method").notNull(),
    status: paymentStatusEnum("status").notNull().default("pending"),
    // Identificador devolvido pelo fornecedor; único para impedir duplicação.
    providerReference: text("provider_reference"),
    failureReason: text("failure_reason"),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("payments_reference_unique").on(table.reference),
    uniqueIndex("payments_provider_reference_unique")
      .on(table.providerReference)
      .where(sql`${table.providerReference} is not null`),
    // Uma inscrição só pode ter um pagamento activo (pendente ou confirmado).
    uniqueIndex("payments_one_active_per_enrollment")
      .on(table.enrollmentId)
      .where(sql`${table.status} in ('pending', 'confirmed')`),
    index("payments_student_created_idx").on(table.studentId, table.createdAt),
    index("payments_teacher_status_idx").on(table.teacherId, table.status),
    check("payments_amount_positive", sql`${table.amount} > 0`),
    check(
      "payments_commission_range",
      sql`${table.commissionAmount} is null or (${table.commissionAmount} >= 0 and ${table.commissionAmount} <= ${table.amount})`,
    ),
  ],
);

// Eventos recebidos do fornecedor (webhooks). O identificador do evento é
// único, o que torna o processamento idempotente.
export const paymentEvents = pgTable(
  "payment_events",
  {
    id: text("id").primaryKey(),
    paymentId: text("payment_id").references(() => payments.id, { onDelete: "set null" }),
    provider: text("provider").notNull(),
    providerEventId: text("provider_event_id").notNull(),
    signatureValid: boolean("signature_valid").notNull(),
    payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("payment_events_provider_event_unique").on(table.provider, table.providerEventId),
    index("payment_events_payment_idx").on(table.paymentId),
  ],
);

export const refunds = pgTable(
  "refunds",
  {
    id: text("id").primaryKey(),
    paymentId: text("payment_id")
      .notNull()
      .references(() => payments.id, { onDelete: "restrict" }),
    amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
    reason: text("reason").notNull(),
    status: refundStatusEnum("status").notNull().default("requested"),
    requestedBy: text("requested_by")
      .notNull()
      .references(() => educaUsers.id, { onDelete: "restrict" }),
    decidedBy: text("decided_by").references(() => educaUsers.id, { onDelete: "restrict" }),
    decisionNotes: text("decision_notes"),
    ...timestamps,
  },
  (table) => [
    index("refunds_payment_idx").on(table.paymentId),
    index("refunds_status_idx").on(table.status, table.createdAt),
    check("refunds_amount_positive", sql`${table.amount} > 0`),
  ],
);

// Carteira interna do professor: registo contabilístico, não uma conta bancária.
// O livro é só de acrescentar (append-only); os saldos obtêm-se somando
// os movimentos. O frontend nunca escreve aqui.
export const walletEntries = pgTable(
  "wallet_entries",
  {
    id: text("id").primaryKey(),
    teacherId: text("teacher_id")
      .notNull()
      .references(() => educaUsers.id, { onDelete: "restrict" }),
    type: walletEntryTypeEnum("type").notNull(),
    bucket: walletBucketEnum("bucket").notNull(),
    // Valor com sinal: positivo credita, negativo debita.
    amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
    currency: text("currency").notNull().default("MZN"),
    paymentId: text("payment_id").references(() => payments.id, { onDelete: "restrict" }),
    refundId: text("refund_id").references(() => refunds.id, { onDelete: "restrict" }),
    // Chave de idempotência: impede lançar duas vezes o mesmo movimento.
    idempotencyKey: text("idempotency_key").notNull(),
    description: text("description"),
    createdBy: text("created_by").references(() => educaUsers.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("wallet_entries_idempotency_unique").on(table.idempotencyKey),
    index("wallet_entries_teacher_created_idx").on(table.teacherId, table.createdAt),
    index("wallet_entries_teacher_bucket_idx").on(table.teacherId, table.bucket),
    index("wallet_entries_payment_idx").on(table.paymentId),
    check("wallet_entries_amount_nonzero", sql`${table.amount} <> 0`),
  ],
);

export const withdrawalRequests = pgTable(
  "withdrawal_requests",
  {
    id: text("id").primaryKey(),
    teacherId: text("teacher_id")
      .notNull()
      .references(() => educaUsers.id, { onDelete: "restrict" }),
    amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
    currency: text("currency").notNull().default("MZN"),
    method: paymentMethodEnum("method").notNull(),
    // Número de carteira móvel de destino; só visível ao professor e à administração.
    destination: text("destination").notNull(),
    status: withdrawalStatusEnum("status").notNull().default("requested"),
    decidedBy: text("decided_by").references(() => educaUsers.id, { onDelete: "restrict" }),
    decisionNotes: text("decision_notes"),
    // Só existe quando o fornecedor autorizado confirma a transferência.
    providerReference: text("provider_reference"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index("withdrawal_requests_teacher_created_idx").on(table.teacherId, table.createdAt),
    index("withdrawal_requests_status_idx").on(table.status, table.createdAt),
    check("withdrawal_requests_amount_positive", sql`${table.amount} > 0`),
  ],
);

export const notifications = pgTable(
  "notifications",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => educaUsers.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("notifications_user_created_idx").on(table.userId, table.createdAt),
    index("notifications_user_unread_idx").on(table.userId).where(sql`${table.readAt} is null`),
  ],
);

export const reports = pgTable(
  "reports",
  {
    id: text("id").primaryKey(),
    reporterId: text("reporter_id")
      .notNull()
      .references(() => educaUsers.id, { onDelete: "cascade" }),
    // "review", "lesson" ou "user"
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    reason: text("reason").notNull(),
    details: text("details"),
    status: reportStatusEnum("status").notNull().default("open"),
    resolvedBy: text("resolved_by").references(() => educaUsers.id, { onDelete: "set null" }),
    resolution: text("resolution"),
    ...timestamps,
  },
  (table) => [
    index("reports_status_created_idx").on(table.status, table.createdAt),
    index("reports_target_idx").on(table.targetType, table.targetId),
    uniqueIndex("reports_one_open_per_reporter_target")
      .on(table.reporterId, table.targetType, table.targetId)
      .where(sql`${table.status} in ('open', 'in_review')`),
  ],
);
