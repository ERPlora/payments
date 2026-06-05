-- Un pago por id (scope hub_id). Portado de PaymentService.get_payment.
SELECT id, reference, payment_method_id, payment_date, amount, currency,
       beneficiary_name, beneficiary_iban, concept, status, supplier_invoice_ref
FROM payments_payment
WHERE id = :payment_id AND hub_id = :hub_id AND is_deleted = 0;
