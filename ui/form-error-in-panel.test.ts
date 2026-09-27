// pm#513 (out of pm#478) — on a phone or a tablet, a refused «New payment» showed NOTHING: the person
// pressed «New payment» and the sheet stayed as it was.
//
// The refusal did arrive; it was painted in the wrong place. The form lives in the `create` panel of
// the `ok-data-table`, and under 834 px that panel is a FULL-SCREEN sheet (outfitkit#75). The notice
// was a child of the PAGE, so on a phone it sat under the sheet, out of sight (bench: hub:stable
// 1.1.30, 390 and 820 px, ios and md: 4 of 6 hidden). On a desktop the panel sits beside the table
// and the notice happened to be visible.
//
// The rule, the same one customers#97 / tables#93 / reservations#73 / appointments#227 / tasks#47 /
// tickets#43 / cart_checkout#31 follow:
//
//   · what goes wrong while SAVING a form is painted INSIDE that form, above the button that was
//     pressed, and scrolled into view once — not again on every keystroke (rv-reservations-73);
//   · what goes wrong OUTSIDE the save stays on the PAGE: a refused row action («Advance»,
//     «Cancel»), a row that cannot take that step, and a list that does not load. No panel is open
//     then, and a notice inside a closed panel is just as invisible (rv-appointments-227).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const PAYMENT = {
  id: 'p1',
  reference: 'PAY-2026-0001',
  payment_method_id: 'm1',
  payment_date: '2026-09-28',
  amount: 1250,
  currency: 'EUR',
  status: 'draft',
  beneficiary_name: 'Proveedor SL',
  concept: '',
};

const REFUSAL = 'A manager has to approve this.';

let refuse: string | null = null;
/** When set, the next command waits on it: lets a test look at the screen while a save is in flight. */
let hold: Promise<void> | null = null;
let loadFails = false;
/** How many times the list was read: an action that goes through reloads it. */
let reads = 0;
let commands: string[] = [];
/** Every element the component scrolled into view. */
let revealed: Element[] = [];
/** Whether each revealed element had already painted itself when it was scrolled to. */
let paintedWhenRevealed: boolean[] = [];

beforeEach(() => {
  refuse = null;
  hold = null;
  loadFails = false;
  reads = 0;
  commands = [];
  revealed = [];
  paintedWhenRevealed = [];
  vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(function (this: HTMLElement) {
    revealed.push(this);
    // ok-inline-feedback lays itself out in its own update: scrolled to before it, a phone scrolls to
    // an empty, zero-height box and the notice ends up off the sheet anyway (online_booking#33).
    paintedWhenRevealed.push((this as unknown as { hasUpdated?: boolean }).hasUpdated !== false);
  });
  // «Cancel» asks for the reason with the browser prompt.
  (globalThis as Record<string, unknown>).prompt = () => 'Duplicated';
  (globalThis as Record<string, unknown>).erplora = {
    query: async () => [],
    queryOptional: async () => [{ id: 'm1', name: 'Transfer', method_type: 'transfer', is_active: 1 }],
    queryPage: async () => {
      reads++;
      if (loadFails) throw new Error(REFUSAL);
      return { rows: [PAYMENT], total: 1 };
    },
    command: async (name: string) => {
      commands.push(name);
      const wait = hold;
      if (wait) await wait;
      if (refuse) throw new Error(refuse);
      return {};
    },
    on: () => () => {},
    locale: 'es',
    t: (_c: unknown, key: string) => key,
    currency: 'EUR',
    currencyDecimals: 2,
    formatMoney: (cents: number) => `${(cents / 100).toFixed(2)} EUR`,
  };
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).prompt;
});

type Wc = HTMLElement & { shadowRoot: ShadowRoot; updateComplete: Promise<unknown> } & Record<string, any>;

async function mount(): Promise<Wc> {
  await import('./components/erp-payments-list/erp-payments-list');
  const el = document.createElement('erp-payments-list') as Wc;
  document.body.appendChild(el);
  await settle(el);
  return el;
}

async function settle(el: Wc): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await el.updateComplete;
    await new Promise((r) => setTimeout(r, 0));
  }
}

const submitEvent = (): Event => new Event('submit', { cancelable: true });

const CREATE = 'form[slot="create"]';

/** The notice inside `scope`, or null. */
const inside = (el: Wc, scope: string, testid: string): Element | null =>
  el.shadowRoot.querySelector(`${scope} [data-testid="${testid}"]`);

/** Every place a notice with `text` is painted in, by where it sits. */
function whereIs(el: Wc, text: string): string[] {
  return [...el.shadowRoot.querySelectorAll('ok-inline-feedback')]
    .filter((n) => n.textContent?.trim() === text)
    .map((n) => (n.closest(CREATE) ? 'panel' : 'page'));
}

/** The notice sits above the button of its form. */
function aboveTheButton(form: Element, testid: string): boolean {
  const kids = [...form.children];
  const notice = kids.findIndex((k) => k.getAttribute('data-testid') === testid);
  const button = kids.findIndex((k) => k.tagName === 'ION-BUTTON' && k.getAttribute('type') === 'submit');
  return notice >= 0 && button >= 0 && notice < button;
}

function fillForm(el: Wc): void {
  el.newMethodId = 'm1';
  el.newDate = '2026-09-28';
  el.newAmount = '12.50';
  el.newBeneficiary = 'Proveedor SL';
}

async function refusedCreate(el: Wc): Promise<void> {
  fillForm(el);
  refuse = REFUSAL;
  await el.createPayment(submitEvent());
  await settle(el);
}

async function rowAction(el: Wc, actionId: 'advance' | 'cancel', row: Record<string, unknown> = PAYMENT): Promise<void> {
  el.onRowAction({ detail: { actionId, row } });
  await settle(el);
}

describe('pm#513 · payments: a refused «New payment» is shown INSIDE the panel form', () => {
  it('lands in the form, with its text, painted and scrolled into view — nothing on the page under the sheet', async () => {
    const el = await mount();
    await refusedCreate(el);
    const notice = inside(el, CREATE, 'payments-form-error');
    expect(notice, 'on a phone the panel covers the page: the refusal has to travel with the form').not.toBeNull();
    expect(notice?.textContent?.trim()).toBe(REFUSAL);
    expect(revealed, 'and it is scrolled into view').toEqual([notice]);
    expect(paintedWhenRevealed, 'once it has painted itself').toEqual([true]);
    expect(whereIs(el, REFUSAL)).toEqual(['panel']);
  });

  it('sits above the «New payment» button that was pressed', async () => {
    const el = await mount();
    await refusedCreate(el);
    expect(aboveTheButton(el.shadowRoot.querySelector(CREATE)!, 'payments-form-error')).toBe(true);
  });

  it('is revealed once, not again on every keystroke while the person corrects the payment', async () => {
    const el = await mount();
    await refusedCreate(el);
    revealed = [];
    el.newAmount = '13';
    await settle(el);
    el.newBeneficiary = 'Proveedor SA';
    await settle(el);
    expect(inside(el, CREATE, 'payments-form-error'), 'the refusal is still there').not.toBeNull();
    expect(revealed, 'but the sheet stays where the person is typing').toEqual([]);
  });

  it('a second refusal with a different reason is revealed again', async () => {
    const el = await mount();
    await refusedCreate(el);
    revealed = [];
    refuse = 'The method is not active.';
    await el.createPayment(submitEvent());
    await settle(el);
    expect(revealed).toEqual([inside(el, CREATE, 'payments-form-error')]);
  });

  it('while the new attempt is being saved, the previous refusal is already gone', async () => {
    const el = await mount();
    await refusedCreate(el);
    refuse = null;
    let release!: () => void;
    hold = new Promise((r) => (release = r));
    const attempt = el.createPayment(submitEvent());
    await settle(el);
    expect(inside(el, CREATE, 'payments-form-error')).toBeNull();
    release();
    await attempt;
  });

  it('a save that goes through also clears the page notice of an earlier refused row action', async () => {
    const el = await mount();
    refuse = REFUSAL;
    await rowAction(el, 'advance');
    expect(whereIs(el, REFUSAL)).toEqual(['page']);
    refuse = null;
    fillForm(el);
    await el.createPayment(submitEvent());
    await settle(el);
    expect(whereIs(el, REFUSAL)).toEqual([]);
  });
});

describe('pm#513 · payments: what goes wrong OUTSIDE the save stays on the page (rv-appointments-227)', () => {
  it('a refused «Advance» from a row is shown on the page, not in the (closed) panel', async () => {
    const el = await mount();
    refuse = REFUSAL;
    await rowAction(el, 'advance');
    expect(commands).toEqual(['payments.payments.approve']);
    expect(inside(el, '.page', 'payments-error')?.textContent?.trim()).toBe(REFUSAL);
    expect(whereIs(el, REFUSAL)).toEqual(['page']);
    expect(inside(el, CREATE, 'payments-form-error')).toBeNull();
  });

  it('a refused «Cancel» from a row is shown on the page too', async () => {
    const el = await mount();
    refuse = REFUSAL;
    await rowAction(el, 'cancel');
    expect(commands).toEqual(['payments.payments.cancel']);
    expect(whereIs(el, REFUSAL)).toEqual(['page']);
  });

  it('a row that cannot be cancelled or advanced says so on the page, without asking the hub', async () => {
    const el = await mount();
    await rowAction(el, 'cancel', { ...PAYMENT, status: 'completed' });
    expect(inside(el, '.page', 'payments-error')?.textContent?.trim()).toBe('ui.errNoCancel');
    await rowAction(el, 'advance', { ...PAYMENT, status: 'completed' });
    expect(inside(el, '.page', 'payments-error')?.textContent?.trim()).toBe('ui.errNoTransition');
    expect(commands).toEqual([]);
    expect(el.shadowRoot.querySelector(`${CREATE} [data-testid="payments-form-error"]`)).toBeNull();
  });

  it('a new row action clears the previous refusal while it runs', async () => {
    const el = await mount();
    refuse = REFUSAL;
    await rowAction(el, 'advance');
    refuse = null;
    let release!: () => void;
    hold = new Promise((r) => (release = r));
    el.onRowAction({ detail: { actionId: 'advance', row: PAYMENT } });
    await settle(el);
    expect(whereIs(el, REFUSAL)).toEqual([]);
    release();
    await settle(el);
  });

  it('a row action does not wipe a refusal the person is still reading in the form', async () => {
    const el = await mount();
    await refusedCreate(el);
    refuse = null;
    await rowAction(el, 'advance');
    expect(whereIs(el, REFUSAL)).toEqual(['panel']);
  });

  it('a row action that goes through reloads the list', async () => {
    const el = await mount();
    const before = reads;
    await rowAction(el, 'advance');
    expect(reads, 'the approved payment would keep showing as draft').toBe(before + 1);
    await rowAction(el, 'cancel');
    expect(reads, 'the cancelled payment would keep showing as open').toBe(before + 2);
  });

  it('a list that does not load is shown on the page, not in the form', async () => {
    loadFails = true;
    const el = await mount();
    expect(whereIs(el, REFUSAL)).toEqual(['page']);
    expect(inside(el, CREATE, 'payments-form-error')).toBeNull();
  });
});
