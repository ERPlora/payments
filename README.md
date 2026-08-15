# Módulo `payments` — pagos salientes

Registra el dinero que **SALE**: pagos a proveedor, transferencias y reembolsos, con flujo
`draft → approved → sent → completed` (o `cancelled`) y referencia atómica por hub y día
`PAY-YYYYMMDD-NNNN`. Incluye el catálogo de **métodos de pago** desde los que se paga.

> ⚠️ **Es el inverso del TPV.** `sales` registra el dinero que **entra** del cliente; aquí un
> «método de pago» es desde dónde pagas TÚ, no cómo te paga el cliente. Y **este módulo no mueve
> dinero**: no habla con ningún banco, no genera SEPA — «enviado» es un estado que pone una persona.

> **Module id:** `payments`. **Depende de:** nada — y nada depende de él.
> Módulo híbrido: SQL + handler WASM (`create_payment`).

## Documentación de usuario — [`docs/`](docs/)

Viaja **dentro** del módulo y se versiona con él: el asistente del hub (ADR-0282) la indexa por
versión instalada y cita la de TU versión, no la de la última publicada. En inglés (idioma fuente).

| Fichero | Para qué |
| ------- | -------- |
| [`docs/overview.md`](docs/overview.md) | Qué hace y qué NO hace; por qué NO es el TPV; el ciclo de vida |
| [`docs/screens.md`](docs/screens.md) | Registrar, aprobar, marcar enviado/completado, cancelar y los métodos de pago |
| [`docs/concepts.md`](docs/concepts.md) | Aquí **no se mueve dinero**, la escalera de estados solo sube, transición inválida = **no-op MUDO**, `add_` vs `approve_` = segregación de funciones, la fecha de la referencia es la del SERVIDOR |
| [`docs/limits.md`](docs/limits.md) | Los 4 códigos de validación, los 5 fallos mudos, permisos y diagnóstico |

## Qué expone hoy

| Tipo | Nombre | Permiso |
| ---- | ------ | ------- |
| query | `payments.payments.list` / `.get` · `payments.methods.list` | `view_payment` |
| command | `payments.payments.create` (WASM) · `.mark_sent` · `.mark_completed` · `payments.methods.create` | `add_payment` |
| command | `payments.payments.approve` · `.cancel` | `approve_payment` |
| emite | `payments.payment.created/approved/sent/completed/cancelled` | — |
| escucha | — | — |

Navegación: `erp-payments-list` («Payments»), que se suscribe a los 5 eventos para recargar en vivo.

## Layout

```text
module.json                   # manifest (contrato técnico)
migrations/postgres/          # esquema §2.5; amount INTEGER en CÉNTIMOS (ADR-0007) + contador atómico
queries/*.sql                 # lecturas declarativas (:hub_id inyectado)
commands/*.sql                # escrituras declarativas (las `_` son intenciones del WASM)
schemas/*.json                # JSON Schemas de input (draft 2020-12)
handler/                      # WASM Tier 2 → dist/handler.wasm
ui/                           # Web Components (Lit/Ionic/OutfitKit)
docs/                         # documentación de usuario + corpus del asistente
```

## Estado y trabajo abierto

El estado vive en las **Issues de este repo**, no aquí. Verificado E2E contra runtime y Postgres
reales, incluidas 30 creaciones concurrentes sin referencias duplicadas (payments#1/#2, ADR-0026).
Limitaciones documentadas en `docs/limits.md`: las guardas de estado y la de método
inexistente/inactivo fallan como **no-op mudo**, y el runtime no devuelve datos del handler al caller.

Doc de arquitectura: `architecture/modules/payments.md` (cargarlo antes de tocar el módulo).
⚠️ Ese doc dice que `amount` es NUMERIC «pendiente de migrar a céntimos»: está **desfasado** — la
migración ya lo declara `INTEGER` en céntimos.
