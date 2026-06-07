-- Lista de pagos salientes del hub (más recientes primero). Runtime inyecta :hub_id.
-- Portado de PaymentService.list_payments (filtro de estado opcional vía :status).
-- :status = '' (cadena vacía) → no filtra; cualquier valor → filtra por ese estado.
SELECT id, reference, payment_method_id, payment_date, amount, currency,
       beneficiary_name, beneficiary_iban, concept, status, supplier_invoice_ref
FROM payments_payment
WHERE hub_id = :hub_id AND is_deleted = 0
