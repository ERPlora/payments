-- Payment methods configured for this hub. The runtime injects :hub_id.
--
-- ⚠️ There is NO `:active_only` bind, and there never was one. The name survived in a comment from
-- the `PaymentService.list_methods` this query was ported from, and ERPlora/hub#1173 is what
-- believing it cost: the alta asked for `{ active_only: 1 }`, the list engine dropped the unknown
-- parameter in silence and returned the WHOLE list, so a payment could be created against a method
-- the owner had DEACTIVATED. Only the declarative `list` block of `module.json` filters — on the
-- wire, as `f_<column>` (`f_is_active`).
SELECT id, name, method_type, bank_account_ref, is_active
FROM payments_payment_method
WHERE hub_id = :hub_id AND is_deleted = 0
