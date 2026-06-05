-- Alta de método de pago. Runtime inyecta :new_id, :hub_id, :current_user_id, :now.
-- Portado de PaymentService.create_method (validación de method_type vía JSON Schema enum).
INSERT INTO payments_payment_method
  (id, hub_id, name, method_type, bank_account_ref, is_active,
   is_deleted, created_by, updated_by, created_at, updated_at)
VALUES
  (:new_id, :hub_id, :name, :method_type, :bank_account_ref, 1,
   0, :current_user_id, :current_user_id, :now, :now);
