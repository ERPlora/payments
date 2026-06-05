-- Transición sent → completed. Portado de PaymentService.mark_completed.
-- Guard de origen (status = 'sent') en el WHERE.
UPDATE payments_payment
SET status = 'completed',
    updated_by = :current_user_id,
    updated_at = :now
WHERE id = :payment_id AND hub_id = :hub_id AND is_deleted = 0 AND status = 'sent';
