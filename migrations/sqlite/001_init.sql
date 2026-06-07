-- Payments · esquema inicial (SQLite). Portado fielmente de modules/m_payments/models.py.
-- Pagos salientes (inverso de sales/ingresos): pagos a proveedores, transferencias,
-- reembolsos. Modelos: PaymentMethod, Payment, PaymentCounter.
-- Contrato de fila estándar de hub (§2.5): hub_id + soft-delete + auditoría.

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
