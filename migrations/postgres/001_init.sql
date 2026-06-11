-- Payments · esquema inicial (Postgres / Aurora cloud). Equivalente a
-- migrations/sqlite/001_init.sql — los commands/queries SQL son COMPARTIDOS entre
-- dialectos, así que la paridad de columnas/tipos es obligatoria.
--
-- Criterio de tipos (ADR-0007, subconjunto portable "ERPlora SQL"):
--   * ids/refs → TEXT (UUIDs generados por el runtime como texto);
--   * flags 0/1 → INTEGER (no BOOLEAN: los commands bindean 0/1);
--   * fechas (*_at, payment_date, day) → TEXT ISO-8601 (el runtime bindea strings
--     RFC3339; el orden lexicográfico ISO == orden cronológico);
--   * amount → NUMERIC (paridad con la migración SQLite actual; la migración
--     fleet-wide a céntimos INTEGER de ADR-0007 queda pendiente para TODOS los módulos).

-- Método de pago saliente (cuenta bancaria, efectivo, tarjeta, sepa, cheque, otro).
CREATE TABLE IF NOT EXISTS payments_payment_method (
    id               TEXT PRIMARY KEY,
    hub_id           TEXT NOT NULL,
    name             TEXT NOT NULL,
    method_type      TEXT NOT NULL DEFAULT 'transfer',   -- cash|transfer|card|sepa|check|other
    bank_account_ref TEXT NOT NULL DEFAULT '',
    is_active        INTEGER NOT NULL DEFAULT 1,
    is_deleted       INTEGER NOT NULL DEFAULT 0,
    deleted_at       TEXT,
    created_by       TEXT,
    updated_by       TEXT,
    created_at       TEXT NOT NULL,
    updated_at       TEXT
);
CREATE INDEX IF NOT EXISTS ix_payments_method_hub        ON payments_payment_method (hub_id, is_deleted);
CREATE INDEX IF NOT EXISTS ix_payments_method_hub_active ON payments_payment_method (hub_id, is_active);

-- Pago saliente con flujo de estados: draft → approved → sent → completed (o cancelled).
CREATE TABLE IF NOT EXISTS payments_payment (
    id                   TEXT PRIMARY KEY,
    hub_id               TEXT NOT NULL,
    reference            TEXT NOT NULL,                    -- PAY-YYYYMMDD-NNNN
    payment_method_id    TEXT NOT NULL,
    payment_date         TEXT NOT NULL,
    amount               NUMERIC NOT NULL,
    currency             TEXT NOT NULL DEFAULT 'EUR',
    beneficiary_name     TEXT NOT NULL,
    beneficiary_iban     TEXT NOT NULL DEFAULT '',
    concept              TEXT NOT NULL DEFAULT '',
    status               TEXT NOT NULL DEFAULT 'draft',    -- draft|approved|sent|completed|cancelled
    supplier_invoice_ref TEXT NOT NULL DEFAULT '',
    is_deleted           INTEGER NOT NULL DEFAULT 0,
    deleted_at           TEXT,
    created_by           TEXT,
    updated_by           TEXT,
    created_at           TEXT NOT NULL,
    updated_at           TEXT,
    FOREIGN KEY (payment_method_id) REFERENCES payments_payment_method (id)
);
CREATE INDEX        IF NOT EXISTS ix_payments_payment_hub        ON payments_payment (hub_id, is_deleted);
CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_payment_reference  ON payments_payment (hub_id, reference);
CREATE INDEX        IF NOT EXISTS ix_payments_payment_hub_status ON payments_payment (hub_id, status);
CREATE INDEX        IF NOT EXISTS ix_payments_payment_hub_date   ON payments_payment (hub_id, payment_date);
CREATE INDEX        IF NOT EXISTS ix_payments_payment_hub_method ON payments_payment (hub_id, payment_method_id);

-- Contador atómico de referencias por (hub, día) — upsert sin race window.
-- El índice único (hub_id, day) es OBLIGATORIO: es el arbiter del
-- ON CONFLICT (hub_id, day) de commands/_bump_counter.sql.
CREATE TABLE IF NOT EXISTS payments_payment_counter (
    id          TEXT PRIMARY KEY,
    hub_id      TEXT NOT NULL,
    day         TEXT NOT NULL,                              -- YYYYMMDD
    last_number INTEGER NOT NULL DEFAULT 0,
    is_deleted  INTEGER NOT NULL DEFAULT 0,
    deleted_at  TEXT,
    created_by  TEXT,
    updated_by  TEXT,
    created_at  TEXT,
    updated_at  TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_counter_hub_day ON payments_payment_counter (hub_id, day);
