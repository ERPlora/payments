-- Alta de pago en estado draft. Op final de create_payment; el handler WASM aporta
-- :reference (PAY-YYYYMMDD-NNNN ya calculada) tras validar método, importe y fecha.
-- Runtime inyecta :new_id, :hub_id, :current_user_id, :now. Portado de PaymentService.create_payment.
INSERT INTO payments_payment
  (id, hub_id, reference, payment_method_id, payment_date, amount, currency,
   beneficiary_name, beneficiary_iban, concept, status, supplier_invoice_ref,
   is_deleted, created_by, updated_by, created_at, updated_at)
VALUES
  (:new_id, :hub_id, :reference, :payment_method_id, :payment_date, :amount, :currency,
   :beneficiary_name, :beneficiary_iban, :concept, 'draft', :supplier_invoice_ref,
   0, :current_user_id, :current_user_id, :now, :now);
