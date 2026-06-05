-- Incrementa atómicamente el contador de pagos del día (upsert). Primera op de
-- create_payment. Runtime inyecta :new_id, :hub_id. :day lo aporta el handler WASM.
-- Portado de generate_payment_reference (models.py): genera PAY-YYYYMMDD-NNNN.
INSERT INTO payments_payment_counter (id, hub_id, day, last_number, created_at, updated_at)
VALUES (:new_id, :hub_id, :day, 1, :now, :now)
ON CONFLICT (hub_id, day) DO UPDATE SET last_number = last_number + 1, updated_at = :now;
