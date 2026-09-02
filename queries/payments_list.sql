-- Outbound payments of this hub. The runtime injects :hub_id.
--
-- ⚠️ There is NO `:status` bind either — same inheritance from `PaymentService.list_payments`, same
-- trap as `:active_only` in `methods_list.sql` (ERPlora/hub#1173). Filtering, sorting and searching
-- are declared in the `list` block of `module.json` and reach the engine as `f_<column>`.
SELECT id, reference, payment_method_id, payment_date, amount, currency,
       beneficiary_name, beneficiary_iban, concept, status, supplier_invoice_ref
FROM payments_payment
WHERE hub_id = :hub_id AND is_deleted = 0
