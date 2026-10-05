# WORKFLOW — Pagos

Prefijo: PAYMENTS
Alcance MVP: fuera del MVP

## Para qué sirve y para quién

Registra el dinero que **sale** del negocio: pagos a proveedores, transferencias y reembolsos, cada uno con
una referencia propia (`PAY-AAAAMMDD-NNNN`) y una escalera de estados (borrador, aprobado, enviado,
completado, o cancelado) para separar a quien registra de quien autoriza. Lo usan el **administrador** y
el **responsable**; el **empleado** solo mira.

Es lo contrario del cobro del TPV. Un «método de pago» de este módulo es **desde dónde paga el negocio**
(su cuenta, su tarjeta, el efectivo del cajón), no cómo paga el cliente: ese catálogo es de Venta
(`sales_payment_method`) y no tiene relación con este. **No mueve dinero**: no habla con ningún banco, no
genera ficheros SEPA ni ejecuta transferencias; «Enviado» es un estado que pone una persona. El módulo no
depende de ningún otro y ningún otro módulo lo lee (comprobado: solo el catálogo de disparadores de
Automatizaciones nombra uno de sus avisos).

## Referencia adoptada

Pagos a proveedor con aprobación por estados, como el registro de pagos de Odoo y de Business Central
(diario de pagos: borrador, registrado, conciliado). Se copia solo la escalera de estados y la separación
de permisos entre quien crea y quien aprueba; no hay conciliación bancaria ni remesas. Sin investigación
nueva: es lo que cita `architecture/modules/payments.md`.

## Antes de empezar

- Instalar el módulo. Al instalarlo **no** aparece ningún método de pago: hay que crear al menos uno
  antes de poder registrar un pago (PAYMENTS-F01).
- Permisos: el administrador tiene todos; el responsable puede ver, registrar, aprobar y cancelar; el
  empleado solo ve la lista.
- La moneda del pago es la del hub; si el hub nunca fijó moneda, euros.

## Pantallas

### Pagos
Entrada «Pagos» del menú (título interior «Pagos salientes»). Una tabla con las columnas Referencia, Fecha,
Beneficiario, Importe y Estado; búsqueda («Buscar referencia o beneficiario…»), filtros por columna
(referencia y beneficiario por fragmento, fecha por rango, importe «desde / hasta» en unidades normales,
estado por lista), orden por columna y 50 filas por página, ordenada por la fecha del pago (la más reciente arriba; no por la de alta). Por fila, dos
acciones: «Avanzar» y «Cancelar». El «+» abre el panel «Nuevo pago» (Método, Fecha, Importe,
Beneficiario, Concepto). Vacía: «Sin pagos.»; cargando: «Cargando…»; error de carga: aviso rojo con
«Reintentar». Un rechazo de una acción de fila sale como aviso rojo sobre la tabla; uno del alta, dentro
del panel.

No hay pantalla de ajustes (el módulo no declara `settings`) ni pantalla de métodos de pago.

## Flujos

### PAYMENTS-F01 Crear un método de pago
Estado: parcial — no hay pantalla: solo por el asistente o la API, y la orden no tiene etiqueta traducida para la tarjeta de confirmación; editar, desactivar y borrar un método no existen
Actor: administrador, responsable, asistente
Pantalla: asistente
Pasos:
1. Pide al asistente crear un método de pago, con nombre y tipo (efectivo, transferencia, tarjeta, SEPA, cheque u otro).
2. Opcionalmente da la referencia de la cuenta bancaria.
3. Confirma la tarjeta del asistente.
4. El método queda disponible en el desplegable «Método» del panel «Nuevo pago».
Entra: nombre, tipo y referencia de cuenta, de la persona.
Sale: un método activo del hub. No avisa a nadie.
Si falla: un tipo fuera de la lista se rechaza entero; sin permiso de registrar pagos, no se ofrece. El panel «Nuevo pago» sin ningún método avisa «Todavía no hay métodos de pago. Hay que crear uno antes de poder registrar un pago.»
Implicados: ninguno
QA: ninguno

### PAYMENTS-F02 Registrar un pago
Estado: parcial — por la API, un alta con un método inexistente contesta bien, gasta un número de referencia y emite el aviso de pago creado sin crear ningún pago
Actor: administrador, responsable
Pantalla: Pagos
Pasos:
1. En «Pagos» pulsa «+» para abrir «Nuevo pago».
2. Elige el Método, la Fecha, escribe el Importe en unidades normales (por ejemplo 12,50), el Beneficiario y, si quiere, el Concepto.
3. Pulsa «Nuevo pago».
4. El panel se cierra y el pago aparece en la lista como «Borrador», con su referencia (la lista va ordenada por la fecha del pago: uno con fecha antigua no sale arriba).
Entra: los datos del panel, de la persona; la moneda del hub. El importe se lee en el formato del hub y se guarda como entero en la unidad menor (12,50 € = 1250); un importe ambiguo («1.250») o que no es una cifra se rechaza dentro del panel.
Sale: un pago en borrador con referencia `PAY-AAAAMMDD-NNNN` (la fecha es la del día en que se registra, no la del pago; contador atómico por hub y día) y el aviso de pago creado (`payments.payment.created`, que lleva el nombre del beneficiario, el importe y la moneda). El IBAN y la referencia de factura de proveedor no se piden en pantalla: se guardan vacíos.
Si falla: importe vacío, 0 o negativo, «El importe de un pago tiene que ser mayor que 0.». Desde la pantalla no hay otro rechazo posible: el desplegable solo ofrece métodos del hub y no hay forma de desactivarlos. Por la API o el asistente: un método mal formado, un nombre vacío o una fecha ilegible se rechazan con un error genérico, sin código (el hub redacta el error del manejador), y no se guarda nada; un método bien formado pero inexistente o de otro negocio no se rechaza: no se guarda ningún pago, pero la orden contesta bien, se gasta un número de referencia del día y sale el aviso de pago creado. El importe por la API es el entero en unidad menor y la moneda, si falta, la del hub.
Implicados: FLOWS-F13
QA: ninguno

### PAYMENTS-F03 Aprobar un pago
Estado: parcial — aprobar lo que no está en borrador, o sin indicar pago, no cambia nada pero contesta bien y emite el aviso
Actor: administrador, responsable
Pantalla: Pagos
Pasos:
1. En la fila de un pago en «Borrador», pulsa «Avanzar».
2. La fila pasa a «Aprobado».
Entra: el pago elegido.
Sale: el estado y quién lo cambió; el aviso `payments.payment.approved`.
Si falla: quien solo registra (sin permiso de aprobar) no puede aprobar. Aprobar un pago que ya no está en borrador, o sin indicar el pago (por la API), no cambia nada, la orden contesta bien y el aviso de aprobado sale igualmente (la orden no declara `expect_rows` ni esquema).
Implicados: FLOWS-F13
QA: ninguno

### PAYMENTS-F04 Marcar un pago como enviado y como completado
Estado: parcial — «completar» (o «enviar») sobre un pago que no está en el estado previo, o inexistente, no cambia nada pero contesta bien y emite igualmente su aviso
Actor: administrador, responsable
Pantalla: Pagos
Pasos:
1. En la fila de un pago «Aprobado», pulsa «Avanzar»: pasa a «Enviado».
2. Cuando el banco o el proveedor lo ha recibido, pulsa «Avanzar» otra vez: pasa a «Completado».
Entra: el pago elegido.
Sale: el estado; los avisos `payments.payment.sent` y `payments.payment.completed`. No se mueve dinero ni se contacta con ningún banco.
Si falla: sobre un pago «Completado» o «Cancelado», «Avanzar» dice «El pago no admite más transiciones.». Cada paso exige el anterior en el SQL, pero saltarse uno por la API no se rechaza: no cambia ninguna fila, la orden contesta bien y sale igualmente el aviso (`sent` o `completed`), también con un pago inexistente o sin indicar el pago.
Implicados: FLOWS-F13
QA: ninguno

### PAYMENTS-F05 Cancelar un pago
Estado: parcial — cancelar un pago terminado o inexistente por la API no cambia nada pero contesta bien y emite el aviso
Actor: administrador, responsable
Pantalla: Pagos
Pasos:
1. En la fila de un pago que no está completado ni cancelado, pulsa «Cancelar».
2. Escribe el «Motivo de cancelación:» en el cuadro que sale.
3. La fila pasa a «Cancelado».
Entra: el pago y el motivo (obligatorio).
Sale: estado cancelado, y el motivo añadido al concepto como `[CANCELLED] <motivo>` (el pago cancelado no se borra); el aviso `payments.payment.cancelled`.
Si falla: sin motivo no se envía nada; sobre un pago terminado, «El pago ya no admite cancelación.». No hay forma de deshacer una aprobación: se cancela y se crea otro pago. Por la API, cancelar un pago ya terminado o inexistente no cambia nada, contesta bien y emite igualmente el aviso de cancelado.
Implicados: FLOWS-F13
QA: ninguno

### PAYMENTS-F06 Buscar y revisar los pagos
Estado: hecho
Actor: administrador, responsable, empleado
Pantalla: Pagos
Pasos:
1. Abre «Pagos».
2. Escribe en el buscador una parte de la referencia, el beneficiario o la referencia de factura de proveedor, o usa los filtros de columna.
3. Ordena por la columna que necesite.
Entra: lo que teclea la persona.
Sale: nada; solo lectura. La lista se recarga sola cuando otro usuario crea o cambia un pago.
Si falla: error de carga con «Reintentar». El empleado sí tiene permiso de ver; un perfil sin él ve igualmente la pestaña (la entrada de menú no declara permiso) y recibe el rechazo de la consulta como error de carga.
Implicados: ninguno
QA: ninguno

### PAYMENTS-F07 Avisar a una automatización de un pago completado
Estado: parcial — una orden «completar» que no cambia nada también dispara la automatización
Actor: sistema
Pantalla: ninguna
Pasos:
1. Un pago pasa a «Completado» (PAYMENTS-F04), o se pide «completar» sobre uno que no lo está (también sale el aviso).
2. Una automatización que arranque con «pago completado» se dispara.
Entra: el aviso `payments.payment.completed`, que lleva el identificador del pago y los datos del sistema, no el importe ni el beneficiario.
Sale: la ejecución de la automatización que haya elegido ese disparador; este módulo no escucha nada de nadie.
Si falla: sin automatización elegida no pasa nada. Los cinco avisos del módulo son elegibles como disparadores (Automatizaciones ofrece todo aviso que declare un módulo instalado); «pago completado» es el único con frase propia. Con un «completar» en falso la automatización arranca sin pago completado.
Implicados: FLOWS-F13
QA: ninguno

## Cobertura contra la referencia

| Elemento | Estado | Flujo |
|---|---|---|
| Método de pago (alta) | parcial: solo asistente/API | PAYMENTS-F01 |
| Método de pago (editar, desactivar, borrar) | no existe | — |
| Registrar pago a proveedor | parcial: alta con método inexistente | PAYMENTS-F02 |
| Aprobación separada de quien registra | parcial: avisos en falso; hecho en lo demás (permisos distintos; nada impide que lo haga la misma persona si tiene ambos) | PAYMENTS-F03 |
| Enviado y completado manuales | parcial: avisos en falso | PAYMENTS-F04 |
| Cancelación con motivo | parcial: aviso en falso por la API | PAYMENTS-F05 |
| Buscar, filtrar, ordenar | hecho | PAYMENTS-F06 |
| Disparador de automatización | parcial: los cinco avisos son elegibles; pueden salir en falso | PAYMENTS-F02 a F05, F07 |

## Datos: de quién es cada dato

- **Propios**: métodos de pago (`payments_payment_method`), pagos (`payments_payment`) y el contador
  diario de referencias (`payments_payment_counter`). Todos con `hub_id`, borrado lógico y auditoría
  (quién creó o cambió).
- **Lee de otro**: solo la moneda del hub (`hub_settings`, del núcleo). Nada de Venta, Caja, Facturación
  ni Clientes.
- **Datos personales**: nombre del beneficiario (viaja también en el aviso de pago creado, al registro de avisos y a cualquier automatización), IBAN del beneficiario (solo por la API; la pantalla no
  lo pide), concepto y motivo de cancelación (texto libre, pueden contener nombres), identificador de
  quien creó o cambió cada fila. No hay borrado RGPD propio: el borrado es lógico.
- **Importes**: entero en la unidad menor de la moneda de la fila (céntimos en euros), con su `currency`.

## Reglas que no se rompen

- Todo dato lleva `hub_id` y se filtra por él; ninguna lectura cruza hubs.
- Importe siempre entero en unidad menor y mayor que 0; la pantalla y el manejador lo exigen.
- Cada transición exige su estado de origen en el propio SQL; no hay vuelta atrás.
- Aprobar y cancelar piden `payments.approve_payment`; registrar, enviar, completar y crear métodos piden
  `payments.add_payment`.
- La referencia no se repite por hub (índice único) y se calcula en la misma transacción que el alta.
- Este módulo nunca emite ni toca documentos fiscales (VeriFactu no interviene).

## Lo que NO hace, a propósito

- No mueve dinero ni habla con bancos; no genera SEPA ni concilia extractos.
- No registra cobros de clientes: eso es Venta (`sales`) y sus formas de cobro; la caja y su arqueo por
  medio de pago salen de las ventas, no de aquí.
- No registra devoluciones al cliente ni pagos parciales de una venta: las devoluciones son de Venta.
- No valida el IBAN y no enlaza la «referencia de factura de proveedor» con ninguna factura.
- No hay pagos parciales de un pago (un pago es un importe) ni edición de importes.
- No tiene integración con datáfono ni pasarela de tarjeta; ese cobro es del TPV y del hub, y `payment_gateways` está congelado.

## Dudas abiertas

- Riesgo sin confirmar (haría falta ejecutar el asistente): con el módulo instalado el asistente gana sus órdenes como herramientas, y la descripción del módulo («inbound and outbound», «Cobros y pagos» en la traducción) puede llevarlo a elegirlas para un cobro de cliente, que es de Venta. Además ninguna orden lleva `ai.risk` ni etiqueta traducida, así que la tarjeta de confirmación es genérica.

- El catálogo lo marca retirado (saas#1542, según `architecture/modules/payments.md`): sin confirmar si hoy
  puede instalarse desde el marketplace.

## Fuentes contrastadas

- `locales/es.json` describe el módulo como «Cobros y pagos» y el manifest en inglés habla de «inbound and
  outbound»: el módulo solo registra pagos **salientes**; los `docs/` y el README lo dicen bien.
- `architecture/modules/payments.md` dice `amount` NUMERIC; la migración lo declara INTEGER en céntimos y la
  pantalla lo trata como unidad menor.
- Los `docs/` (conceptos) hablan de redondeo «half-even»; el manejador y su test usan HALF_UP (ADR-0123 §4).
  Además `schemas/create_payment.json` declara `amount` entero, así que un decimal por API se rechaza antes de
  llegar al manejador.
- Las órdenes de transición no declaran `expect_rows` ni esquema, así que una transición sin efecto contesta bien y
  emite su aviso igualmente (`payments.payment.completed` incluido, que es disparador de F07). Lo mismo `payments._insert_payment`: un método inexistente gasta número y emite el aviso de creado.
- El manejador devuelve sus rechazos como `Err`, que el hub redacta a un error genérico sin código; la pantalla valida el importe antes por eso.
- La pantalla usa `fill="outline"` sin `mode="md"` en `ion-select`/`ion-input` del alta (en modo `ios` no pinta el borde).
- `locales/es.json` no tiene bloque `commands` con etiquetas: la tarjeta del asistente para estas órdenes
  saldría sin nombre («Una acción que esta app no sabe nombrar»), confirmado en el hub (`apps/web/src/lib/elevation-label.ts`).
