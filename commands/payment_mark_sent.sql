-- Transición approved → sent. Portado de PaymentService.mark_sent.
-- Guard de origen (status = 'approved') en el WHERE.
UPDATE payments_payment
SET status = 'sent',
    updated_by = :current_user_id,
    updated_at = :now
WHERE id = :payment_id AND hub_id = :hub_id AND is_deleted = 0 AND status = 'approved';
