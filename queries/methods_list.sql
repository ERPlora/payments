-- Lista de métodos de pago configurados del hub (orden alfabético). Runtime inyecta :hub_id.
-- Portado de PaymentService.list_methods (filtro active_only opcional vía :active_only).
-- :active_only = 1 → solo activos; 0 → todos.
SELECT id, name, method_type, bank_account_ref, is_active
FROM payments_payment_method
WHERE hub_id = :hub_id AND is_deleted = 0
