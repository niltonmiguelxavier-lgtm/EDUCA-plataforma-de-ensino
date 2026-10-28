BEGIN;

CREATE TYPE lesson_payment_status AS ENUM (
  'pending', 'processing', 'confirmed', 'failed', 'cancelled', 'refund_pending', 'refunded'
);
CREATE TYPE payment_provider_event_result AS ENUM (
  'unmatched', 'rejected', 'accepted', 'duplicate'
);
CREATE TYPE teacher_wallet_bucket AS ENUM ('pending', 'available', 'reserved');
CREATE TYPE wallet_movement_type AS ENUM (
  'lesson_credit', 'pending_release', 'withdrawal_reserve', 'withdrawal_release',
  'withdrawal_settlement', 'refund', 'adjustment', 'reversal'
);
CREATE TYPE wallet_entry_direction AS ENUM ('credit', 'debit');
CREATE TYPE withdrawal_request_status AS ENUM (
  'requested', 'in_review', 'approved', 'processing', 'completed',
  'rejected', 'failed', 'cancelled'
);

CREATE TABLE commission_policies (
  id text PRIMARY KEY,
  teacher_id text REFERENCES educa_users(id) ON DELETE RESTRICT,
  rate_basis_points integer NOT NULL,
  effective_from timestamptz NOT NULL,
  effective_until timestamptz,
  reason text NOT NULL,
  created_by text NOT NULL REFERENCES educa_users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT commission_policies_rate_range CHECK (rate_basis_points BETWEEN 0 AND 10000),
  CONSTRAINT commission_policies_date_range CHECK (effective_until IS NULL OR effective_until > effective_from)
);
CREATE UNIQUE INDEX commission_policies_global_effective_idx
  ON commission_policies(effective_from) WHERE teacher_id IS NULL;
CREATE UNIQUE INDEX commission_policies_teacher_effective_idx
  ON commission_policies(teacher_id, effective_from) WHERE teacher_id IS NOT NULL;
CREATE INDEX commission_policies_teacher_effective_lookup_idx
  ON commission_policies(teacher_id, effective_from);

CREATE TABLE lesson_payments (
  id text PRIMARY KEY,
  enrollment_id text NOT NULL REFERENCES lesson_enrollments(id) ON DELETE RESTRICT,
  lesson_id text NOT NULL REFERENCES lessons(id) ON DELETE RESTRICT,
  student_id text NOT NULL REFERENCES educa_users(id) ON DELETE RESTRICT,
  teacher_id text NOT NULL REFERENCES educa_users(id) ON DELETE RESTRICT,
  provider_code text NOT NULL,
  provider_transaction_id text,
  idempotency_key text NOT NULL UNIQUE,
  expected_amount_mzn numeric(12, 2) NOT NULL,
  captured_amount_mzn numeric(12, 2),
  currency text NOT NULL DEFAULT 'MZN',
  commission_policy_id text REFERENCES commission_policies(id) ON DELETE RESTRICT,
  commission_rate_basis_points integer,
  commission_amount_mzn numeric(12, 2),
  teacher_net_amount_mzn numeric(12, 2),
  status lesson_payment_status NOT NULL DEFAULT 'pending',
  confirmed_at timestamptz,
  failure_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lesson_payments_expected_amount_positive CHECK (expected_amount_mzn > 0),
  CONSTRAINT lesson_payments_snapshot_consistent CHECK (
    (captured_amount_mzn IS NULL AND commission_policy_id IS NULL
      AND commission_rate_basis_points IS NULL AND commission_amount_mzn IS NULL
      AND teacher_net_amount_mzn IS NULL)
    OR
    (captured_amount_mzn IS NOT NULL AND captured_amount_mzn = expected_amount_mzn
      AND commission_policy_id IS NOT NULL AND commission_rate_basis_points IS NOT NULL
      AND commission_rate_basis_points BETWEEN 0 AND 10000
      AND commission_amount_mzn IS NOT NULL AND commission_amount_mzn >= 0
      AND teacher_net_amount_mzn IS NOT NULL AND teacher_net_amount_mzn >= 0
      AND commission_amount_mzn + teacher_net_amount_mzn = captured_amount_mzn)
  ),
  CONSTRAINT lesson_payments_confirmed_has_snapshot CHECK (
    (status IN ('confirmed', 'refund_pending', 'refunded')
      AND confirmed_at IS NOT NULL AND captured_amount_mzn IS NOT NULL)
    OR
    (status NOT IN ('confirmed', 'refund_pending', 'refunded')
      AND confirmed_at IS NULL AND captured_amount_mzn IS NULL)
  )
);
CREATE UNIQUE INDEX lesson_payments_provider_transaction_idx
  ON lesson_payments(provider_code, provider_transaction_id)
  WHERE provider_transaction_id IS NOT NULL;
CREATE INDEX lesson_payments_enrollment_created_idx
  ON lesson_payments(enrollment_id, created_at);
CREATE INDEX lesson_payments_teacher_status_idx
  ON lesson_payments(teacher_id, status);
CREATE INDEX lesson_payments_student_created_idx
  ON lesson_payments(student_id, created_at);

CREATE TABLE payment_provider_events (
  id text PRIMARY KEY,
  payment_id text REFERENCES lesson_payments(id) ON DELETE RESTRICT,
  provider_code text NOT NULL,
  provider_event_id text NOT NULL,
  event_type text NOT NULL,
  payload_sha256 text NOT NULL,
  signature_verified boolean NOT NULL DEFAULT false,
  processing_result payment_provider_event_result NOT NULL DEFAULT 'unmatched',
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  CONSTRAINT payment_provider_events_once UNIQUE (provider_code, provider_event_id),
  CONSTRAINT payment_provider_events_accepted_verified
    CHECK (processing_result <> 'accepted' OR signature_verified)
);
CREATE INDEX payment_provider_events_payment_received_idx
  ON payment_provider_events(payment_id, received_at);
COMMENT ON TABLE payment_provider_events IS
  'Audit metadata only; raw provider payloads and credentials are not stored.';

CREATE TABLE teacher_wallets (
  id text PRIMARY KEY,
  teacher_id text NOT NULL UNIQUE REFERENCES educa_users(id) ON DELETE RESTRICT,
  currency text NOT NULL DEFAULT 'MZN',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT teacher_wallets_id_owner_unique UNIQUE (id, teacher_id)
);
COMMENT ON TABLE teacher_wallets IS
  'Wallet identity only. Balances are derived from wallet_ledger_entries; no balance column exists.';

CREATE TABLE withdrawal_requests (
  id text PRIMARY KEY,
  reference text NOT NULL UNIQUE,
  idempotency_key text NOT NULL UNIQUE,
  wallet_id text NOT NULL,
  teacher_id text NOT NULL REFERENCES educa_users(id) ON DELETE RESTRICT,
  amount_mzn numeric(12, 2) NOT NULL,
  currency text NOT NULL DEFAULT 'MZN',
  payout_method_code text NOT NULL,
  payout_destination_ref text,
  status withdrawal_request_status NOT NULL DEFAULT 'requested',
  requested_at timestamptz NOT NULL DEFAULT now(),
  reviewed_by text REFERENCES educa_users(id) ON DELETE RESTRICT,
  reviewed_at timestamptz,
  review_note text,
  payout_provider_reference text,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT withdrawal_requests_amount_positive CHECK (amount_mzn > 0),
  CONSTRAINT withdrawal_requests_completed_has_reference
    CHECK (status <> 'completed' OR (completed_at IS NOT NULL AND payout_provider_reference IS NOT NULL)),
  CONSTRAINT withdrawal_requests_wallet_owner_fk
    FOREIGN KEY (wallet_id, teacher_id) REFERENCES teacher_wallets(id, teacher_id) ON DELETE RESTRICT
);
CREATE INDEX withdrawal_requests_teacher_status_idx
  ON withdrawal_requests(teacher_id, status, created_at);
CREATE UNIQUE INDEX withdrawal_requests_payout_reference_idx
  ON withdrawal_requests(payout_provider_reference)
  WHERE payout_provider_reference IS NOT NULL;
COMMENT ON COLUMN withdrawal_requests.payout_destination_ref IS
  'Opaque provider token/reference only; never store a mobile PIN or raw bank details.';

CREATE TABLE withdrawal_request_events (
  id text PRIMARY KEY,
  withdrawal_request_id text NOT NULL REFERENCES withdrawal_requests(id) ON DELETE RESTRICT,
  status withdrawal_request_status NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  actor_id text REFERENCES educa_users(id) ON DELETE RESTRICT,
  note text,
  provider_reference text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX withdrawal_request_events_request_created_idx
  ON withdrawal_request_events(withdrawal_request_id, created_at);

CREATE TABLE wallet_ledger_operations (
  id text PRIMARY KEY,
  wallet_id text NOT NULL REFERENCES teacher_wallets(id) ON DELETE RESTRICT,
  payment_id text REFERENCES lesson_payments(id) ON DELETE RESTRICT,
  withdrawal_request_id text REFERENCES withdrawal_requests(id) ON DELETE RESTRICT,
  reversal_of_operation_id text REFERENCES wallet_ledger_operations(id) ON DELETE RESTRICT,
  operation_type wallet_movement_type NOT NULL,
  reference text NOT NULL UNIQUE,
  idempotency_key text NOT NULL UNIQUE,
  reason text NOT NULL,
  created_by text REFERENCES educa_users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wallet_ledger_operations_source_matches_type CHECK (
    (operation_type IN ('lesson_credit', 'pending_release', 'refund')
      AND payment_id IS NOT NULL AND withdrawal_request_id IS NULL)
    OR
    (operation_type IN ('withdrawal_reserve', 'withdrawal_release', 'withdrawal_settlement')
      AND withdrawal_request_id IS NOT NULL AND payment_id IS NULL)
    OR
    (operation_type = 'adjustment' AND payment_id IS NULL
      AND withdrawal_request_id IS NULL AND created_by IS NOT NULL)
    OR
    (operation_type = 'reversal' AND reversal_of_operation_id IS NOT NULL
      AND payment_id IS NULL AND withdrawal_request_id IS NULL)
  ),
  CONSTRAINT wallet_ledger_operations_reason_nonempty CHECK (length(btrim(reason)) > 0)
);
CREATE INDEX wallet_ledger_operations_wallet_created_idx
  ON wallet_ledger_operations(wallet_id, created_at);
CREATE INDEX wallet_ledger_operations_payment_idx ON wallet_ledger_operations(payment_id);
CREATE INDEX wallet_ledger_operations_withdrawal_idx
  ON wallet_ledger_operations(withdrawal_request_id);
CREATE UNIQUE INDEX wallet_ledger_lesson_credit_once_idx
  ON wallet_ledger_operations(payment_id)
  WHERE payment_id IS NOT NULL AND operation_type = 'lesson_credit';
CREATE UNIQUE INDEX wallet_ledger_withdrawal_reserve_once_idx
  ON wallet_ledger_operations(withdrawal_request_id)
  WHERE withdrawal_request_id IS NOT NULL AND operation_type = 'withdrawal_reserve';

CREATE TABLE wallet_ledger_entries (
  id text PRIMARY KEY,
  operation_id text NOT NULL REFERENCES wallet_ledger_operations(id) ON DELETE RESTRICT,
  bucket teacher_wallet_bucket NOT NULL,
  direction wallet_entry_direction NOT NULL,
  amount_mzn numeric(12, 2) NOT NULL,
  reversal_of_entry_id text REFERENCES wallet_ledger_entries(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wallet_ledger_entries_amount_positive CHECK (amount_mzn > 0),
  CONSTRAINT wallet_ledger_entries_operation_bucket_direction_unique
    UNIQUE (operation_id, bucket, direction)
);
CREATE INDEX wallet_ledger_entries_operation_idx ON wallet_ledger_entries(operation_id);
COMMENT ON TABLE wallet_ledger_entries IS
  'Append-only wallet movements. Compute each bucket as credits minus debits; never store cached balances.';

CREATE FUNCTION reject_append_only_finance_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'financial audit records are append-only; create a reversal or a new version';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER commission_policies_append_only
  BEFORE UPDATE OR DELETE ON commission_policies
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_finance_change();
CREATE TRIGGER payment_provider_events_append_only
  BEFORE UPDATE OR DELETE ON payment_provider_events
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_finance_change();
CREATE TRIGGER withdrawal_request_events_append_only
  BEFORE UPDATE OR DELETE ON withdrawal_request_events
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_finance_change();
CREATE TRIGGER wallet_ledger_operations_append_only
  BEFORE UPDATE OR DELETE ON wallet_ledger_operations
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_finance_change();
CREATE TRIGGER wallet_ledger_entries_append_only
  BEFORE UPDATE OR DELETE ON wallet_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_finance_change();

CREATE FUNCTION protect_lesson_payment_history() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payment records cannot be deleted; record a refund or reversal';
  END IF;
  IF OLD.captured_amount_mzn IS NOT NULL AND (
    NEW.enrollment_id IS DISTINCT FROM OLD.enrollment_id
    OR NEW.lesson_id IS DISTINCT FROM OLD.lesson_id
    OR NEW.student_id IS DISTINCT FROM OLD.student_id
    OR NEW.teacher_id IS DISTINCT FROM OLD.teacher_id
    OR NEW.provider_code IS DISTINCT FROM OLD.provider_code
    OR NEW.provider_transaction_id IS DISTINCT FROM OLD.provider_transaction_id
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.expected_amount_mzn IS DISTINCT FROM OLD.expected_amount_mzn
    OR NEW.captured_amount_mzn IS DISTINCT FROM OLD.captured_amount_mzn
    OR NEW.currency IS DISTINCT FROM OLD.currency
    OR NEW.commission_policy_id IS DISTINCT FROM OLD.commission_policy_id
    OR NEW.commission_rate_basis_points IS DISTINCT FROM OLD.commission_rate_basis_points
    OR NEW.commission_amount_mzn IS DISTINCT FROM OLD.commission_amount_mzn
    OR NEW.teacher_net_amount_mzn IS DISTINCT FROM OLD.teacher_net_amount_mzn
    OR NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at
  ) THEN
    RAISE EXCEPTION 'settled payment snapshots are immutable; record a refund or reversal';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER lesson_payments_history_guard
  BEFORE UPDATE OR DELETE ON lesson_payments
  FOR EACH ROW EXECUTE FUNCTION protect_lesson_payment_history();

CREATE FUNCTION validate_wallet_operation_entries() RETURNS trigger AS $$
DECLARE
  target_operation_id text;
  target_type wallet_movement_type;
  line_count integer;
  credit_total numeric;
  debit_total numeric;
  pending_credit_total numeric;
  pending_debit_total numeric;
  available_credit_total numeric;
  available_debit_total numeric;
  reserved_credit_total numeric;
  reserved_debit_total numeric;
BEGIN
  IF TG_TABLE_NAME = 'wallet_ledger_operations' THEN
    target_operation_id := NEW.id;
  ELSE
    target_operation_id := NEW.operation_id;
  END IF;

  SELECT operation_type INTO target_type
    FROM wallet_ledger_operations WHERE id = target_operation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'wallet ledger operation is missing';
  END IF;

  SELECT count(*)::integer,
    coalesce(sum(CASE WHEN direction = 'credit' THEN amount_mzn ELSE 0 END), 0),
    coalesce(sum(CASE WHEN direction = 'debit' THEN amount_mzn ELSE 0 END), 0),
    coalesce(sum(CASE WHEN bucket = 'pending' AND direction = 'credit' THEN amount_mzn ELSE 0 END), 0),
    coalesce(sum(CASE WHEN bucket = 'pending' AND direction = 'debit' THEN amount_mzn ELSE 0 END), 0),
    coalesce(sum(CASE WHEN bucket = 'available' AND direction = 'credit' THEN amount_mzn ELSE 0 END), 0),
    coalesce(sum(CASE WHEN bucket = 'available' AND direction = 'debit' THEN amount_mzn ELSE 0 END), 0),
    coalesce(sum(CASE WHEN bucket = 'reserved' AND direction = 'credit' THEN amount_mzn ELSE 0 END), 0),
    coalesce(sum(CASE WHEN bucket = 'reserved' AND direction = 'debit' THEN amount_mzn ELSE 0 END), 0)
    INTO line_count, credit_total, debit_total, pending_credit_total, pending_debit_total,
      available_credit_total, available_debit_total, reserved_credit_total, reserved_debit_total
    FROM wallet_ledger_entries WHERE operation_id = target_operation_id;

  IF line_count = 0 THEN
    RAISE EXCEPTION 'wallet ledger operation must contain entries';
  ELSIF target_type = 'pending_release' THEN
    IF line_count <> 2 OR pending_debit_total <> available_credit_total
      OR pending_credit_total <> 0 OR available_debit_total <> 0
      OR reserved_credit_total <> 0 OR reserved_debit_total <> 0 THEN
      RAISE EXCEPTION 'pending release must debit pending and credit available equally';
    END IF;
  ELSIF target_type = 'withdrawal_reserve' THEN
    IF line_count <> 2 OR available_debit_total <> reserved_credit_total
      OR pending_credit_total <> 0 OR pending_debit_total <> 0
      OR available_credit_total <> 0 OR reserved_debit_total <> 0 THEN
      RAISE EXCEPTION 'withdrawal reserve must debit available and credit reserved equally';
    END IF;
  ELSIF target_type = 'withdrawal_release' THEN
    IF line_count <> 2 OR reserved_debit_total <> available_credit_total
      OR pending_credit_total <> 0 OR pending_debit_total <> 0
      OR available_debit_total <> 0 OR reserved_credit_total <> 0 THEN
      RAISE EXCEPTION 'withdrawal release must debit reserved and credit available equally';
    END IF;
  ELSIF target_type = 'lesson_credit' THEN
    IF line_count <> 1 OR pending_credit_total <> credit_total OR debit_total <> 0 THEN
      RAISE EXCEPTION 'lesson credit must be one pending credit';
    END IF;
  ELSIF target_type = 'withdrawal_settlement' THEN
    IF line_count <> 1 OR reserved_debit_total <> debit_total OR credit_total <> 0 THEN
      RAISE EXCEPTION 'withdrawal settlement must debit reserved funds';
    END IF;
  ELSIF target_type = 'refund' AND credit_total <> 0 THEN
    RAISE EXCEPTION 'refund movements must debit wallet funds';
  ELSIF target_type = 'reversal' THEN
    IF EXISTS (
      SELECT 1 FROM wallet_ledger_entries
      WHERE operation_id = target_operation_id AND reversal_of_entry_id IS NULL
    ) THEN
      RAISE EXCEPTION 'reversal entries must point to the original entry';
    END IF;
    IF EXISTS (
      SELECT 1
      FROM wallet_ledger_entries reversed_entry
      JOIN wallet_ledger_entries original_entry
        ON original_entry.id = reversed_entry.reversal_of_entry_id
      JOIN wallet_ledger_operations reversed_operation
        ON reversed_operation.id = reversed_entry.operation_id
      JOIN wallet_ledger_operations original_operation
        ON original_operation.id = reversed_operation.reversal_of_operation_id
      WHERE reversed_entry.operation_id = target_operation_id
        AND (reversed_entry.amount_mzn <> original_entry.amount_mzn
          OR reversed_entry.bucket <> original_entry.bucket
          OR reversed_entry.direction = original_entry.direction
          OR original_operation.wallet_id <> reversed_operation.wallet_id)
    ) THEN
      RAISE EXCEPTION 'reversal must exactly negate an entry in the same wallet';
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER wallet_ledger_operations_entries_required
  AFTER INSERT ON wallet_ledger_operations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION validate_wallet_operation_entries();
CREATE CONSTRAINT TRIGGER wallet_ledger_entries_validate_operation
  AFTER INSERT ON wallet_ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION validate_wallet_operation_entries();

COMMIT;
