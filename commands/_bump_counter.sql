-- Incrementa atómicamente el contador de pagos del día (upsert, UNA sentencia: sin
-- ventana SELECT→UPDATE en SQLite ni en Postgres; en Postgres el ON CONFLICT toma el
-- row-lock de la fila en conflicto, en SQLite escribe el único writer). Primera op de
-- create_payment. Runtime inyecta :new_id, :hub_id. :day lo aporta el handler WASM.
-- Portado de generate_payment_reference (models.py): genera PAY-YYYYMMDD-NNNN.
-- RHS cualificado con el nombre de tabla: en Postgres el identificador sin cualificar
-- puede chocar con `excluded`; SQLite también lo acepta cualificado (portable ADR-0007).
-- Requiere el índice único uq_payments_counter_hub_day (hub_id, day) en AMBOS dialectos.
INSERT INTO payments_payment_counter (id, hub_id, day, last_number, created_at, updated_at)
VALUES (:new_id, :hub_id, :day, 1, :now, :now)
ON CONFLICT (hub_id, day)
DO UPDATE SET last_number = payments_payment_counter.last_number + 1, updated_at = :now;
