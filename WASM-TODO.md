# payments — lógica para handler Rust→WASM (Tier 2)

El CRUD plano y las
transiciones de estado simples (`approve`, `mark_sent`, `mark_completed`, `cancel`,
`method_create`) ya están en SQL declarativo Tier 0 (`commands/*.sql`). Lo que sigue es
lógica de validación / generación atómica de referencia que **no** cabe en una sola
sentencia SQL y debe convertirse en handler WASM (`handler/src/lib.rs` → `dist/handler.wasm`).

> Regla hub: el WASM **nunca toca la BD**. Recibe el payload + datos leídos por el
> runtime, valida y calcula, y devuelve *intenciones* (comandos `_bump_counter` /
> `_insert_payment` a ejecutar) que el runtime valida y persiste en una transacción.
> El importe es decimal con `quantize(0.01)`; nunca float binario.

## 1. `create_payment` (command `payments.payments.create`)
Origen: `PaymentService.create_payment` + `generate_payment_reference` (models.py).
Único command de este módulo con handler `{type:wasm}`. Crea un pago en estado `draft`.

### Validaciones (todas devuelven error con `code` estable; nada se persiste si falla)
- `payment_method_id`: requerido, parseable como UUID → si no, `invalid_payment_method_id`.
 El método debe existir y estar **activo** (`is_active`) — el runtime lo lee y se lo pasa
 al WASM (lookup en `payments_payment_method`); errores `payment_method_not_found` /
 `payment_method_inactive`.
- `amount`: parsear como decimal; no parseable → `invalid_amount`. **Debe ser > 0**
 (`amount <= 0` → `invalid_amount`). Esta es la regla de negocio atómica que justifica el WASM.
- `beneficiary_name`: requerido y no vacío tras `trim()` → si no, `invalid_beneficiary_name`.
 Persistir ya recortado.
- `payment_date`: requerido. Aceptar ISO `YYYY-MM-DD` (→ `T00:00:00+00:00`) o timestamp ISO
 completo; si viene sin zona, asumir UTC. No parseable → `invalid_payment_date`.
- Defaults: `currency` `EUR` (3 letras), `beneficiary_iban`/`concept`/`supplier_invoice_ref` → `""`.

### Generación atómica de referencia `PAY-YYYYMMDD-NNNN`
Origen: `generate_payment_reference` (UPSERT atómico sobre `payments_payment_counter`).
- `day = YYYYMMDD` derivado de **hoy** (capacidad "reloj" del host, no de `payment_date`).
- El WASM emite el comando `_bump_counter` con bind `:day` (UPSERT
 `INSERT ... ON CONFLICT (hub_id, day) DO UPDATE SET last_number = last_number + 1`),
 que el runtime ejecuta y devuelve el `last_number` resultante. Debe ser atómico
 (sin ventana SELECT→UPDATE) en SQLite y Postgres.
- El WASM formatea `PAY-{day}-{n:04d}` (NNNN = secuencia por hub+día, 4 dígitos).

### Persistencia
- El WASM emite `_insert_payment` con la `:reference` ya calculada y los campos validados.
 El runtime inyecta `:new_id`, `:hub_id`, `:current_user_id`, `:now`; el `status` lo fija
 el SQL a `'draft'`.
- Orden de intenciones: `_bump_counter` → `_insert_payment` (en la misma transacción).

### Binds / payload que necesitará
- Payload de entrada (ver `schemas/create_payment.json`): `payment_method_id`, `payment_date`,
 `amount`, `beneficiary_name`, `beneficiary_iban?`, `concept?`, `supplier_invoice_ref?`, `currency?`.
- Datos leídos por el runtime y pasados al WASM: fila del método de pago
 (`id`, `is_active`) para validar existencia/estado.
- Capacidad de reloj del host: fecha actual → `day` para el contador.
- Salida (intenciones): `_bump_counter{day}` y `_insert_payment{reference, payment_method_id,
 payment_date, amount, currency, beneficiary_name, beneficiary_iban, concept, supplier_invoice_ref}`.
- Resultado devuelto al cliente: `{id, reference, status:'draft', amount, created:true}`.
- Emite el evento `payments.payment.created` (declarado en `module.json`).
