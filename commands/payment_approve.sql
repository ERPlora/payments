-- Transición draft → approved. Portado de PaymentService.approve_payment.
-- El guard de estado de origen (status = 'draft') va en el WHERE: si el pago no está
-- en draft no se actualiza ninguna fila (transición inválida).
UPDATE payments_payment
SET status = 'approved',
    updated_by = :current_user_id,
    updated_at = :now
WHERE id = :payment_id AND hub_id = :hub_id AND is_deleted = 0 AND status = 'draft';
