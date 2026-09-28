// Paging of the Payments list after a create (payments#40).
//
// With more than one page of payments, creating one from page 2 left the list on page 2. The list
// reads newest first (`payment_date desc`), so the payment just created is on top of page 1:
// reloading the page the person was on showed another page of old payments, with no sign that
// anything had happened, and it was easy to create the same payment twice. After a create the list
// goes back to its first page — seeing the new payment on top is the confirmation (same recipe as
// Kitchen › Orders, kitchen#133, and the lists of Odoo or Shopify after adding a record).
//
// The fake server below keeps the payments and pages them like the list engine, so the new row has
// to come back FROM THE SERVER to be seen (rv-tasks-48): a test that only counted reloads could not
// tell page 2 from page 1.
import { beforeEach, describe, expect, it } from 'vitest';

type Row = Record<string, unknown> & { id: string; reference: string; payment_date: string; amount: number; status: string };
type Params = { limit: number; offset: number; search?: string; sort?: string; dir?: string; filters?: Record<string, unknown> };

const METHODS = [{ id: 'm1', name: 'Transfer', method_type: 'transfer', bank_account_ref: 'ES00', is_active: 1 }];

let payments: Row[] = [];
let calls: Params[] = [];
let refuse: string | null = null;

function payment(n: number, date = `2026-07-${String(1 + (n % 28)).padStart(2, '0')}`): Row {
  const num = String(n).padStart(4, '0');
  return {
    id: `p${num}`, reference: `PAY-${num}`, payment_method_id: 'm1', payment_date: date, amount: n * 100,
    currency: 'EUR', beneficiary_name: 'Supplier SL', beneficiary_iban: '', concept: '', status: 'draft', supplier_invoice_ref: '',
  };
}

beforeEach(() => {
  refuse = null;
  calls = [];
  // 60 payments, oldest n = 1, newest n = 60 (each one a day later): page 1 = PAY-0060…PAY-0011, page 2 = PAY-0010…PAY-0001.
  payments = Array.from({ length: 60 }, (_, i) => payment(60 - i, new Date(Date.UTC(2026, 4, 1 + 60 - i)).toISOString().slice(0, 10)));
  (globalThis as Record<string, unknown>).erplora = {
    query: async () => [],
    queryOptional: async (name: string) => (name === 'payments.methods.list' ? METHODS : []),
    queryPage: async (_name: string, p: Params) => {
      calls.push(structuredClone(p));
      const sort = (p.sort ?? 'payment_date') as keyof Row;
      const sign = p.dir === 'asc' ? 1 : -1;
      const hits = payments
        .filter((r) => !p.search || r.reference.includes(p.search))
        .filter((r) => !p.filters?.status || r.status === p.filters.status)
        .sort((a, b) => (a[sort] === b[sort] ? 0 : (a[sort] as never) > (b[sort] as never) ? sign : -sign));
      // Copies: a row the component holds must not change when the server does (rv-payment_gateways-45).
      return { rows: hits.slice(p.offset, p.offset + p.limit).map((r) => ({ ...r })), total: hits.length, limit: p.limit, offset: p.offset };
    },
    command: async (name: string, payload: Record<string, unknown>) => {
      if (refuse !== null) throw new Error(refuse);
      if (name === 'payments.payments.create') {
        payments.unshift({ ...payment(payments.length + 1, String(payload.payment_date)), amount: Number(payload.amount) });
      }
      return {};
    },
    on: () => () => {},
    locale: 'es',
    t: (_c: unknown, key: string) => key,
    formatMoney: (cents: number) => `${((cents || 0) / 100).toFixed(2)} €`,
    currencyDecimals: 2,
    currency: 'EUR',
    hasPermission: () => true,
  };
});

type Wc = HTMLElement & { shadowRoot: ShadowRoot; updateComplete: Promise<unknown> } & Record<string, any>;

async function settle(el: Wc): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await el.updateComplete;
    await new Promise((r) => setTimeout(r, 0));
  }
}

async function mount(): Promise<Wc> {
  await import('./erp-payments-list');
  const el = document.createElement('erp-payments-list') as Wc;
  document.body.appendChild(el);
  await settle(el);
  return el;
}

const table = (el: Wc): Wc => el.shadowRoot.querySelector('ok-data-table') as Wc;
const references = (el: Wc): string[] => (table(el).rows as Row[]).map((r) => r.reference);

/** What the person does: the table's pager emits `pageChange` (0-based). */
async function goToPage(el: Wc, page: number): Promise<void> {
  table(el).dispatchEvent(new CustomEvent('pageChange', { detail: page }));
  await settle(el);
}

/** Fills the «New payment» panel and submits it, dated after every payment already there. */
async function createPayment(el: Wc): Promise<void> {
  el.newMethodId = 'm1';
  el.newDate = '2026-09-28';
  el.newAmount = '12';
  el.newBeneficiary = 'New supplier SL';
  el.newConcept = 'Invoice 7';
  await settle(el);
  const form = el.shadowRoot.querySelector('form[slot="create"]') as HTMLElement;
  form.dispatchEvent(new Event('submit', { cancelable: true }));
  await settle(el);
}

describe('creating a payment from a later page brings the list back to its first page', () => {
  it('from page 2, the new payment is the first row the person sees, on page 1', async () => {
    const el = await mount();
    await goToPage(el, 1);
    expect(references(el)[0], 'the control: page 2 is on screen').toBe('PAY-0010');
    expect(table(el).page).toBe(1);

    await createPayment(el);

    expect(references(el)[0], 'the payment just created heads the list').toBe('PAY-0061');
    expect(table(el).page, 'the pager says page 1').toBe(0);
    expect(calls.at(-1)?.offset, 'the reload asks the server for the first page').toBe(0);
  });

  it('the search, the filters and the order the person chose stay as they were', async () => {
    const el = await mount();
    table(el).dispatchEvent(new CustomEvent('searchChange', { detail: 'PAY-00' }));
    table(el).dispatchEvent(new CustomEvent('filterChange', { detail: { col: 'status', value: 'draft' } }));
    // Not the default (payment_date desc): a create that put the default sort back would pass otherwise.
    table(el).dispatchEvent(new CustomEvent('sortChange', { detail: { sort: 'amount', dir: 'asc' } }));
    await settle(el);
    await goToPage(el, 1);

    await createPayment(el);

    const last = calls.at(-1)!;
    expect(last.search, 'the search box is not emptied behind the person').toBe('PAY-00');
    expect(last.filters, 'the column filters are not emptied behind the person').toEqual({ status: 'draft' });
    expect([last.sort, last.dir], 'the sort the person picked is kept').toEqual(['amount', 'asc']);
    expect(last.offset).toBe(0);
    expect(table(el).page).toBe(0);
  });

  it('after picking 25 rows per page, the create reloads the first 25 (the size is kept)', async () => {
    const el = await mount();
    table(el).dispatchEvent(new CustomEvent('pageSizeChange', { detail: 25 }));
    await settle(el);
    await goToPage(el, 1);

    await createPayment(el);

    expect([calls.at(-1)?.offset, calls.at(-1)?.limit]).toEqual([0, 25]);
    expect(references(el)).toHaveLength(25);
    expect(references(el)[0]).toBe('PAY-0061');
  });

  it('a refused create keeps the person on the page they were on', async () => {
    const el = await mount();
    await goToPage(el, 1);
    const before = calls.length;
    refuse = 'A manager has to approve this.';

    await createPayment(el);

    expect(el.formError, 'the control: the create really was refused').toBe('A manager has to approve this.');
    expect(table(el).page, 'nothing was created: the list does not move').toBe(1);
    expect(references(el)[0]).toBe('PAY-0010');
    expect(calls.slice(before).every((p) => p.offset === 50), 'no reload of page 1').toBe(true);
  });
});
