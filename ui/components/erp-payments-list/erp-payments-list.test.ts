// Contrato de la BARRA de la lista de pagos.
//
// El alta de un pago se hacía con un `<form>` suelto ENCIMA de la tabla (método, fecha, importe,
// beneficiario, concepto). El resto del Hub —/employees en el core, `inventory`, `services`— no lo
// hace así: el alta vive DENTRO de `ok-data-table`, detrás del «+» de su barra, que despliega el
// panel `slot="create"`. Los filtros, igual: dentro, detrás del embudo.
//
// OJO: cambio de COLOCACIÓN. El comando `payments.payments.create` y su payload no se tocan.
import { beforeEach, describe, expect, it } from 'vitest';

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

beforeEach(() => {
  comandos.length = 0;
  (globalThis as Record<string, unknown>).erplora = {
    query: async (name: string) => (name === 'payments.methods.list' ? METODOS : []),
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
