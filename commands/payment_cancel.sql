-- Cancela un pago (cualquier estado no terminal → cancelled). Portado de
-- PaymentService.cancel_payment: añade la razón al concepto para trazabilidad.
-- Guard en el WHERE: no cancela pagos ya completados ni ya cancelados.
-- El salto de línea va como literal embebido (portable SQLite↔Postgres, ADR-0007;
-- char(10) es solo-SQLite y chr(10) solo-Postgres).
UPDATE payments_payment
SET status = 'cancelled',
    concept = CASE
        WHEN concept IS NULL OR concept = ''
        THEN '[CANCELLED] ' || :reason
        ELSE concept || '
' || '[CANCELLED] ' || :reason
    END,
    updated_by = :current_user_id,
    updated_at = :now
WHERE id = :payment_id AND hub_id = :hub_id AND is_deleted = 0
  AND status NOT IN ('completed', 'cancelled');
