-- Alta de pago en estado draft. Op final de create_payment (tras _bump_counter, en la
-- MISMA transacción). La referencia PAY-YYYYMMDD-NNNN se calcula leyendo el contador
-- (recién incrementado) con subquery — el guest WASM nunca hace read-back (patrón
-- sales/kitchen/tasks). Padding NNNN portable SQLite↔Postgres (sin printf/lpad,
-- ADR-0007): substr(CAST(10000+n AS TEXT), 2); n >= 10000 cae a su representación plena.
-- Guard del método de pago EN EL SQL (runtime sin lecturas pre-cargadas, ADR-0020):
-- si :payment_method_id no existe vivo y activo en este hub, el INSERT es un no-op
-- (equivalente a payment_method_not_found / payment_method_inactive).
-- Runtime inyecta :hub_id, :current_user_id, :now; el handler aporta :payment_id
-- (de context.new_ids), :day y los campos ya validados. status lo fija el SQL a 'draft'.
-- La unique uq_payments_payment_reference (hub_id, reference) es la guarda final.
INSERT INTO payments_payment
  (id, hub_id, reference, payment_method_id, payment_date, amount, currency,
   beneficiary_name, beneficiary_iban, concept, status, supplier_invoice_ref,
   is_deleted, created_by, updated_by, created_at, updated_at)
SELECT
  :payment_id, :hub_id,
  'PAY-' || :day || '-' ||
  CASE WHEN c.last_number < 10000
       THEN substr(CAST(10000 + c.last_number AS TEXT), 2)
       ELSE CAST(c.last_number AS TEXT)
  END,
  :payment_method_id, :payment_date, :amount, :currency,
  :beneficiary_name, :beneficiary_iban, :concept, 'draft', :supplier_invoice_ref,
  0, :current_user_id, :current_user_id, :now, :now
FROM (
  SELECT last_number FROM payments_payment_counter
  WHERE hub_id = :hub_id AND day = :day
) AS c
WHERE EXISTS (
  SELECT 1 FROM payments_payment_method m
  WHERE m.id = :payment_method_id AND m.hub_id = :hub_id
    AND m.is_deleted = 0 AND m.is_active = 1
);
