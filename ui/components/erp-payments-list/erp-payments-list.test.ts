// Contrato de la BARRA de la lista de pagos.
//
// El alta de un pago se hacía con un `<form>` suelto ENCIMA de la tabla (método, fecha, importe,
// beneficiario, concepto). El resto del Hub —/employees en el core, `inventory`, `services`— no lo
// hace así: el alta vive DENTRO de `ok-data-table`, detrás del «+» de su barra, que despliega el
// panel `slot="create"`. Los filtros, igual: dentro, detrás del embudo.
//
// OJO: cambio de COLOCACIÓN. El comando `payments.payments.create` y su payload no se tocan.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const METODOS = [
  { id: 'm1', name: 'Transferencia', method_type: 'transfer', bank_account_ref: 'ES00', is_active: 1 },
  { id: 'm2', name: 'Caja', method_type: 'cash', bank_account_ref: '', is_active: 1 },
];

// `amount` is INTEGER minor units in the column (ADR-0007/0123) and the handler binds what the
// UI sends straight into it: 25000 is 250,00 €, not 25.000 €.
const PAGO = {
  id: 'p1', reference: 'PAY-0001', payment_method_id: 'm1', payment_date: '2026-07-13',
  amount: 25000, currency: 'EUR', beneficiary_name: 'Proveedor SL', beneficiary_iban: '',
  concept: 'Factura 12', status: 'draft', supplier_invoice_ref: '',
};

const comandos: { name: string; payload: Record<string, unknown> }[] = [];
const consultas: { name: string; params: Record<string, unknown> | undefined }[] = [];

/** Refusal of the runtime, in the shape the SDK throws it: a stable `code`, never prose. */
class RechazoDelRuntime extends Error {
  constructor(readonly code: string, message = code) {
    super(message);
    this.name = 'ErploraError';
  }
}

/** Lo que responde `payments.methods.list` en cada test. Por defecto, los dos métodos activos. */
let respuestaMetodos: () => Promise<unknown> = async () => METODOS;

beforeEach(() => {
  comandos.length = 0;
  consultas.length = 0;
  respuestaMetodos = async () => METODOS;
  const leer = async (name: string, params?: Record<string, unknown>) => {
    consultas.push({ name, params });
    return name === 'payments.methods.list' ? respuestaMetodos() : [];
  };
  (globalThis as Record<string, unknown>).erplora = {
    query: leer,
    // The shell injects the FULL SDK client, so the optional door is always there. It is
    // reproduced with the SDK's own semantics (ADR-0127/0128): `undefined` ONLY when the owner
    // module is absent or deactivated — a 403, a 422 or a 502 are broken contracts and re-throw.
    queryOptional: async (name: string, params?: Record<string, unknown>) => {
      try {
        return await leer(name, params);
      } catch (e) {
        const code = (e as { code?: string })?.code;
        return code === 'module_not_installed' || code === 'module_inactive' ? undefined : Promise.reject(e);
      }
    },
    queryPage: async () => ({ rows: [PAGO], total: 1 }),
    command: async (name: string, payload: Record<string, unknown>) => {
      comandos.push({ name, payload });
      return {};
    },
    on: () => () => {},
    locale: 'es',
    t: (_catalog: unknown, key: string) => key,
    // Same shape the shell injects (module-sdk): minor units in, formatted string out, and the
    // scale of the hub's currency — 2 in EUR, 0 in JPY, 3 in KWD.
    formatMoney: (cents: number) => `${((cents || 0) / 100).toFixed(2)} €`,
    currencyDecimals: 2,
  };
});

async function montar() {
  await import('./erp-payments-list');
  const el = document.createElement('erp-payments-list');
  document.body.appendChild(el);
  await (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;
  await new Promise((r) => setTimeout(r, 0));
  await (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;
  return el as HTMLElement & { shadowRoot: ShadowRoot };
}

const tabla = (el: HTMLElement & { shadowRoot: ShadowRoot }) =>
  el.shadowRoot.querySelector('ok-data-table') as (HTMLElement & { addable: boolean; fill: boolean; close: () => void }) | null;

/** El panel de alta: es donde vive el desplegable de métodos y donde el usuario ve —o no— el fallo. */
const panelAlta = (el: HTMLElement & { shadowRoot: ShadowRoot }) =>
  el.shadowRoot.querySelector('form[slot="create"]') as HTMLElement;

/** Los avisos que pinta el panel de alta, por tono. */
const avisos = (el: HTMLElement & { shadowRoot: ShadowRoot }, tone?: string) =>
  [...panelAlta(el).querySelectorAll('ok-inline-feedback')].filter(
    (n) => tone === undefined || n.getAttribute('tone') === tone,
  );

const textoDe = (nodos: Element[]) => nodos.map((n) => (n.textContent ?? '').trim()).join(' | ');

const botonReintentar = (el: HTMLElement & { shadowRoot: ShadowRoot }) =>
  panelAlta(el).querySelector('[data-act="retry-methods"]');

const selectMetodo = (el: HTMLElement & { shadowRoot: ShadowRoot }) =>
  panelAlta(el).querySelector('ion-select') as HTMLElement;

describe('el alta vive DENTRO de la tabla (paridad con /employees e inventory)', () => {
  it('la tabla declara `addable` → pinta el «+» en su barra', async () => {
    const el = await montar();
    expect(tabla(el)?.addable, 'sin `addable` no hay «+» en la barra de la tabla').toBe(true);
  });

  it('la tabla llena el alto (`fill`)', async () => {
    const el = await montar();
    expect(tabla(el)?.fill).toBe(true);
  });

  it('el formulario de alta se proyecta en el panel `create` de la tabla', async () => {
    const el = await montar();
    const form = el.shadowRoot.querySelector('form[slot="create"]');
    expect(form, 'el formulario de alta no está en el slot `create`').toBeTruthy();
    expect(form?.closest('ok-data-table'), 'el formulario de alta cuelga fuera de la tabla').toBeTruthy();
  });

  it('no queda NINGÚN control de alta suelto fuera de la tabla', async () => {
    const el = await montar();
    const sueltos = [...el.shadowRoot.querySelectorAll('form, ion-input, ion-select, ion-button')].filter(
      (n) => !n.closest('ok-data-table'),
    );
    expect(sueltos.map((n) => n.tagName.toLowerCase()), 'hay controles de alta fuera de la tabla').toEqual([]);
  });
});

describe('el alta sigue funcionando desde el panel', () => {
  it('crear un pago manda payments.payments.create y cierra el panel', async () => {
    const el = await montar();
    const t = tabla(el)!;
    let cerrado = false;
    t.close = () => { cerrado = true; };

    const wc = el as unknown as {
      newMethodId: string; newDate: string; newAmount: string; newBeneficiary: string; newConcept: string;
      createPayment: (ev: Event) => Promise<void>;
    };
    wc.newMethodId = 'm1';
    wc.newDate = '2026-07-13';
    wc.newAmount = '250';
    wc.newBeneficiary = 'Proveedor SL';
    wc.newConcept = 'Factura 12';
    await wc.createPayment(new Event('submit'));

    const alta = comandos.find((c) => c.name === 'payments.payments.create');
    expect(alta, 'no se mandó el alta del pago').toBeTruthy();
    expect(alta!.payload.payment_method_id).toBe('m1');
    expect(alta!.payload.beneficiary_name).toBe('Proveedor SL');
    expect(cerrado, 'el panel de alta no se cerró tras crear').toBe(true);
  });

  it('el select de método del panel se puebla con los métodos reales', async () => {
    const el = await montar();
    const wc = el as unknown as { methods: { name: string }[] };
    expect(wc.methods.map((m) => m.name)).toEqual(['Transferencia', 'Caja']);
  });
});

// The money contract (payments#9). The column is INTEGER minor units and the handler parses the
// payload with `money::from_json`, so both borders have to speak minor units:
//   * reading — 25000 is «250,00 €». Rendering it with `toFixed(2)` printed «25000.00».
//   * writing — the cashier types euros. Sending «12,34» raw made `money::from_json` round the
//     decimal HALF_UP to 12 minor units, so a 12,34 € payment was stored as 0,12 €.
describe('money crosses both borders in minor units', () => {
  const amountColumn = (el: HTMLElement & { shadowRoot: ShadowRoot }) =>
    (el as unknown as { columns: { key: string; format?: (r: Record<string, unknown>) => string }[] }).columns.find(
      (c) => c.key === 'amount',
    );

  it('renders 25000 minor units as 250,00 €, not 25000.00', async () => {
    const el = await montar();
    expect(amountColumn(el)?.format?.(PAGO)).toContain('250.00');
  });

  it('formats through the shell formatter instead of dividing by hand', async () => {
    const el = await montar();
    const visto: number[] = [];
    (globalThis as Record<string, unknown>).erplora = {
      ...((globalThis as Record<string, unknown>).erplora as object),
      formatMoney: (cents: number) => { visto.push(cents); return 'X'; },
    };
    amountColumn(el)?.format?.(PAGO);
    expect(visto, 'the amount column does not go through erplora.formatMoney').toEqual([25000]);
  });

  it('sends the typed euros as integer minor units', async () => {
    const el = await montar();
    const wc = el as unknown as {
      newMethodId: string; newDate: string; newAmount: string; newBeneficiary: string;
      createPayment: (ev: Event) => Promise<void>;
    };
    wc.newMethodId = 'm1';
    wc.newDate = '2026-07-13';
    wc.newAmount = '12,34';
    wc.newBeneficiary = 'Proveedor SL';
    await wc.createPayment(new Event('submit'));

    const alta = comandos.find((c) => c.name === 'payments.payments.create');
    expect(alta!.payload.amount, '12,34 € must travel as 1234, not as «12,34»').toBe(1234);
  });

  it('a whole-euro amount is not mistaken for minor units', async () => {
    const el = await montar();
    const wc = el as unknown as {
      newMethodId: string; newDate: string; newAmount: string; newBeneficiary: string;
      createPayment: (ev: Event) => Promise<void>;
    };
    wc.newMethodId = 'm1';
    wc.newDate = '2026-07-13';
    wc.newAmount = '250';
    wc.newBeneficiary = 'Proveedor SL';
    await wc.createPayment(new Event('submit'));

    expect(comandos.find((c) => c.name === 'payments.payments.create')!.payload.amount).toBe(25000);
  });

  // The scale is the hub's currency, not a fixed 2. In JPY the minor unit IS the yen: a ×100 at
  // this border charges 100 times too much, and the app is free, so a non-euro hub will happen.
  it('uses the hub currency scale, not a hardcoded 2 decimals', async () => {
    const el = await montar();
    (globalThis as Record<string, unknown>).erplora = {
      ...((globalThis as Record<string, unknown>).erplora as object),
      currencyDecimals: 0,
    };
    const wc = el as unknown as {
      newMethodId: string; newDate: string; newAmount: string; newBeneficiary: string;
      createPayment: (ev: Event) => Promise<void>;
    };
    wc.newMethodId = 'm1';
    wc.newDate = '2026-07-13';
    wc.newAmount = '1999';
    wc.newBeneficiary = 'Proveedor SL';
    await wc.createPayment(new Event('submit'));

    expect(
      comandos.find((c) => c.name === 'payments.payments.create')!.payload.amount,
      '1999 ¥ are 1999 minor units, not 199900',
    ).toBe(1999);
  });
});

describe('la tabla se lee en el idioma del hub, no en el del código (payments#20)', () => {
  // El filtro de ESTADO ya traducía sus opciones («Borrador») mientras la CELDA de la misma columna
  // imprimía el valor crudo del dominio («draft»): dos fuentes para un mismo enum, y la tabla —lo
  // que de verdad se lee— tenía la sin traducir. Es el mismo desajuste que staff#37, y se cierra
  // igual: un solo catálogo del que beben la celda y el selector.
  const columna = (el: HTMLElement & { shadowRoot: ShadowRoot }, key: string) =>
    (el as unknown as { columns: { key: string; format?: (r: Record<string, unknown>) => string; options?: { value: string; label: string }[] }[] })
      .columns.find((c) => c.key === key)!;

  it('la celda de ESTADO no imprime el valor del dominio', async () => {
    const el = await montar();
    const estado = columna(el, 'status');
    expect(typeof estado.format, 'la columna `status` no formatea: la celda pinta el crudo').toBe('function');
    expect(
      estado.format!({ status: 'draft' }),
      'la tabla enseña «draft»; el usuario de un hub en español no sabe qué es eso',
    ).not.toBe('draft');
  });

  it('la celda y el filtro de ESTADO dicen LO MISMO para cada uno de los cinco estados', async () => {
    const el = await montar();
    const estado = columna(el, 'status');
    for (const opt of estado.options!) {
      expect(
        estado.format!({ status: opt.value }),
        `la celda y el filtro discrepan en «${opt.value}»: dos fuentes para un enum vuelven a divergir`,
      ).toBe(opt.label);
    }
  });

  it('un estado que el catálogo no conoce se pinta tal cual, no se traga la fila', async () => {
    const el = await montar();
    // Un hub con una versión del módulo más nueva que su catálogo tiene que seguir viendo la fila.
    expect(columna(el, 'status').format!({ status: 'settled' })).toBe('settled');
  });

  it('la FECHA no se pinta en ISO', async () => {
    const el = await montar();
    const fecha = columna(el, 'payment_date');
    expect(
      fecha.format!({ payment_date: '2026-07-13' }),
      'la columna FECHA sigue en ISO: en el resto del hub un día se lee 13/07/2026',
    ).toBe('13/07/2026');
  });

  it('una fecha ilegible se devuelve tal cual en vez de romper la fila', async () => {
    const el = await montar();
    const fecha = columna(el, 'payment_date');
    expect(fecha.format!({ payment_date: '' })).toBe('');
    expect(fecha.format!({ payment_date: 'no-es-una-fecha' })).toBe('no-es-una-fecha');
  });
});

describe('la tabla reacciona a su barra', () => {
  it('cambiar filas/página (`pageSizeChange`) llega al controlador', async () => {
    const el = await montar();
    tabla(el)!.dispatchEvent(new CustomEvent('pageSizeChange', { detail: 25 }));
    const wc = el as unknown as { ctrl: { state: { pageSize: number } } };
    expect(wc.ctrl.state.pageSize, 'la tabla no está escuchando `pageSizeChange`').toBe(25);
  });

  it('el estado del pago se filtra con un select (dominio cerrado)', async () => {
    const el = await montar();
    const cols = (el as unknown as { columns: { key: string; filterType?: string; options?: unknown[] }[] }).columns;
    const estado = cols.find((c) => c.key === 'status');
    expect(estado?.filterType).toBe('select');
    expect(estado?.options?.length).toBe(5);
  });
});

// ── hub#1173: el filtro que la query NO declara se ignoraba en silencio ──────────────────────
//
// El desplegable de métodos pedía `{ active_only: 1 }`. `:active_only` NO existe en
// `queries/methods_list.sql` — solo en un COMENTARIO suyo, herencia del `PaymentService.list_methods`
// del que se portó. El motor de listas lo descartaba sin decir nada y devolvía la lista ENTERA:
// el alta de un pago ofrecía los métodos que el dueño había DESACTIVADO.
//
// El nombre que sí filtra es el del filtro declarado en el bloque `list` del manifest
// (`is_active`, op `eq`), en la forma que el motor lee del cable: `f_<col>`.
describe('hub#1173 — el desplegable de métodos pide solo los ACTIVOS, con el filtro que existe', () => {
  it('llama a payments.methods.list con el filtro declarado `f_is_active`, nunca con `active_only`', async () => {
    await montar();

    const llamada = consultas.find((c) => c.name === 'payments.methods.list');
    expect(llamada, 'el componente consulta los métodos de pago').toBeTruthy();
    expect(
      llamada?.params,
      'el manifest declara el filtro `is_active` (op eq); el motor lo lee como `f_is_active`',
    ).toEqual({ f_is_active: 1 });
    expect(
      Object.keys(llamada?.params ?? {}),
      '`active_only` no es un parámetro de esta query: hoy el runtime lo RECHAZA (unknown_filter)',
    ).not.toContain('active_only');
  });
});

// ── payments#24: el `catch {}` mudo de `loadMethods()` ───────────────────────────────────────
//
// La lectura de métodos iba envuelta en `catch { /* métodos opcionales para el alta */ }`, que se
// tragaba CUALQUIER fallo: red caída, 403 de permisos, 422 de contrato, 502 del proxy. El usuario
// abría el alta, veía el desplegable VACÍO, y nada —ni aviso, ni consola— distinguía «este hub no
// tiene métodos configurados» de «no se han podido cargar».
//
// Son dos estados con acciones OPUESTAS: el primero se arregla creando un método; el segundo,
// reintentando. La pantalla los pintaba igual. Lo que sí es ausencia de verdad —el módulo
// desinstalado o desactivado, ADR-0127/0128— sigue siendo silencio, y para eso está `queryOptional`.
describe('payments#24 — los métodos tienen tres estados, y se distinguen', () => {
  let consola: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consola = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consola.mockRestore();
  });

  it('la lectura falla → la pantalla DICE que falló, en vez de ofrecer un desplegable vacío', async () => {
    respuestaMetodos = async () => { throw new RechazoDelRuntime('permission_denied'); };
    const el = await montar();

    expect(
      textoDe(avisos(el, 'danger')),
      'el alta no dice nada: el desplegable sale vacío y el usuario no sabe por qué (payments#24)',
    ).not.toBe('');
  });

  it('el fallo ofrece REINTENTAR, que es la acción que lo arregla', async () => {
    respuestaMetodos = async () => { throw new RechazoDelRuntime('unavailable'); };
    const el = await montar();

    expect(botonReintentar(el), 'un fallo de carga sin reintento deja al usuario sin salida').toBeTruthy();
  });

  it('reintentar vuelve a preguntar y, si va bien, puebla el desplegable y borra el aviso', async () => {
    respuestaMetodos = async () => { throw new RechazoDelRuntime('unavailable'); };
    const el = await montar();
    const antes = consultas.filter((c) => c.name === 'payments.methods.list').length;

    respuestaMetodos = async () => METODOS;
    (botonReintentar(el) as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 0));
    await (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;

    expect(
      consultas.filter((c) => c.name === 'payments.methods.list').length,
      'el reintento no vuelve a preguntar',
    ).toBe(antes + 1);
    expect((el as unknown as { methods: { name: string }[] }).methods.map((m) => m.name)).toEqual(['Transferencia', 'Caja']);
    expect(avisos(el, 'danger'), 'el aviso de error sigue puesto tras un reintento que fue bien').toHaveLength(0);
  });

  it('el `code` del rechazo llega a la consola: un fallo que no se ve no existe', async () => {
    respuestaMetodos = async () => { throw new RechazoDelRuntime('invalid_filter'); };
    await montar();

    expect(
      JSON.stringify(consola.mock.calls),
      'la consola no nombra el `code` del rechazo, que es lo único accionable en soporte',
    ).toContain('invalid_filter');
  });

  it('un fallo NO se disfraza de «no hay métodos»', async () => {
    respuestaMetodos = async () => { throw new RechazoDelRuntime('unavailable'); };
    const el = await montar();

    expect(
      avisos(el, 'warning'),
      'un fallo de carga pintado como vacío legítimo manda al usuario a crear un método que ya existe',
    ).toHaveLength(0);
  });

  it('sin métodos configurados lo dice, y NO parece un error', async () => {
    respuestaMetodos = async () => [];
    const el = await montar();

    expect(
      textoDe(avisos(el, 'warning')),
      'el hub no tiene métodos y el alta no lo explica: el desplegable sale vacío sin más',
    ).not.toBe('');
    expect(avisos(el, 'danger'), 'un vacío legítimo pintado en rojo dice «reintenta» cuando hay que CREAR').toHaveLength(0);
    expect(botonReintentar(el), 'un vacío legítimo no se arregla reintentando').toBeFalsy();
  });

  it('mientras carga no finge estar vacío: el desplegable espera, sin aviso de vacío ni de error', async () => {
    respuestaMetodos = () => new Promise(() => {}); // nunca resuelve: el estado se queda en «cargando»
    const el = await montar();

    expect(selectMetodo(el).hasAttribute('disabled'), 'el desplegable se puede tocar antes de tener nada dentro').toBe(true);
    expect(avisos(el, 'warning'), 'cargando NO es «no hay métodos»').toHaveLength(0);
    expect(avisos(el, 'danger'), 'cargando NO es un error').toHaveLength(0);
  });

  // ADR-0127/0128: la ausencia del módulo dueño (o su desactivación en cascada) SÍ es ausencia.
  // `queryOptional` la perdona con `undefined`; todo lo demás explota. Un `catch {}` se tragaba las
  // dos cosas — por eso esa forma se retiró del SDK.
  for (const code of ['module_not_installed', 'module_inactive']) {
    it(`\`${code}\` es ausencia, no error: ni aviso rojo ni ruido en consola`, async () => {
      respuestaMetodos = async () => { throw new RechazoDelRuntime(code); };
      const el = await montar();

      expect(avisos(el, 'danger'), `\`${code}\` no es un fallo que reintentar: el módulo no está`).toHaveLength(0);
      expect(consola.mock.calls, `\`${code}\` es ausencia esperada: no ensucia la consola`).toHaveLength(0);
    });
  }

  it('la lectura pasa por la puerta OPCIONAL del SDK, no por un `catch` que se traga todo', async () => {
    const vistas: string[] = [];
    const cliente = (globalThis as Record<string, unknown>).erplora as Record<string, unknown>;
    const original = cliente.queryOptional as (n: string, p?: Record<string, unknown>) => Promise<unknown>;
    cliente.queryOptional = async (n: string, p?: Record<string, unknown>) => { vistas.push(n); return original(n, p); };
    await montar();

    expect(
      vistas,
      'los métodos se leen con `query` + `catch`: eso no distingue una ausencia de un contrato roto',
    ).toContain('payments.methods.list');
  });
});
