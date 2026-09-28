import { LitElement, html, css, nothing } from 'lit';
import type { PropertyValues } from 'lit';
import { state } from 'lit/decorators.js';
import { define } from '@erplora/outfitkit/define';
import '@erplora/outfitkit/ok-inline-feedback';
import '@erplora/outfitkit/ok-data-table';
import type { DataTableColumn, DataTableAction } from '@erplora/outfitkit';
import { createListController } from '@erplora/module-sdk';
import type { ListController, ListClient, ListParams, ListPage } from '@erplora/module-sdk';
// What a person types or pastes into a money field, read the one way every module reads it (pm#521).
import { formatMoneyInput, normaliseMoneyInput, parseMoneyInput } from '@erplora/module-toolkit/money-input';
// One catalogue for every closed domain of the module: the CELL and the FILTER of a column read
// from it, so they cannot say different things about the same value (payments#20).
import { PAYMENT_STATUS_KEY, enumLabel, enumOptions, formatDate } from '../../lib/enums';
// Catálogo i18n del módulo (ADR-0055): esbuild inlinea estos JSON en el `dist` del WC. Los textos
// internos se resuelven con `erplora.t(CATALOG, 'ui.clave')` (idioma activo, fallback locale→en→clave).
import esLocale from '../../../locales/es.json';
import enLocale from '../../../locales/en.json';
const CATALOG: Record<string, unknown> = { es: esLocale, en: enLocale };

interface ErploraClientLike extends ListClient {
  query<T = unknown>(name: string, params?: Record<string, unknown>): Promise<T>;
  /**
   * The OPTIONAL read door (ADR-0127/0128). It answers `undefined` for exactly one thing — the
   * owner module being absent or deactivated — and re-throws everything else. That is the whole
   * difference from a `catch {}`, which swallowed both and left the screen unable to tell them
   * apart (payments#24).
   */
  queryOptional<T = unknown>(name: string, params?: Record<string, unknown>): Promise<T | undefined>;
  queryPage<R = unknown>(name: string, params: ListParams): Promise<ListPage<R>>;
  command<T = unknown>(name: string, payload?: Record<string, unknown>): Promise<T>;
  on(event: string, cb: (payload: unknown) => void): () => void;
  /** i18n del módulo (ADR-0055): idioma activo + traducción del catálogo `ui`. */
  locale: string;
  t(catalog: Record<string, unknown>, key: string, params?: Record<string, unknown>): string;
  /** Money always travels as INTEGER minor units (ADR-0007/0123) → ALWAYS `formatMoney`, never
   *  a hand-rolled ÷100: it is what applies the hub's currency and decimal count. */
  formatMoney(minor: number, opts?: { currency?: string; locale?: string }): string;
  /** Decimals of the hub's currency — the scale of money. 2 in EUR, 0 in JPY, 3 in KWD. */
  currencyDecimals: number;
  /** ISO code of the hub's currency: the only one a typed amount may carry (pm#521). */
  currency: string;
}

interface Payment {
  id: string;
  reference: string;
  payment_method_id: string;
  payment_date: string;
  /** INTEGER minor units (ADR-0007/0123), not a decimal string. */
  amount: number;
  currency: string;
  beneficiary_name: string;
  beneficiary_iban: string;
  concept: string;
  status: string;
  supplier_invoice_ref: string;
}

interface PaymentMethod {
  id: string;
  name: string;
  method_type: string;
  bank_account_ref: string;
  is_active: number;
}

function erplora(): ErploraClientLike {
  const c = (globalThis as { erplora?: ErploraClientLike }).erplora;
  if (!c) throw new Error('erplora SDK no inicializado por el shell');
  return c;
}

/**
 * The amount FIELD → minor units of the hub currency, or the sentence that says why it cannot be
 * read (pm#521). It used to go through `replace(',', '.')` + `Number()`: «1.250,50» — verbatim what
 * the list prints — became 0, and «1.250» was stored as 1,25 €. `minor: null` = nothing typed.
 */
function readMoneyField(typed: string): { ok: true; minor: number | null } | { ok: false; message: string } {
  const c = erplora();
  const d = c.currencyDecimals;
  const read = parseMoneyInput(typed, d, { currency: c.currency || undefined, locale: c.locale });
  if (read.ok) return read;
  if (read.code === 'ambiguous_amount') {
    // Both readings, in the hub's format, so the person can copy the one they meant back.
    return {
      ok: false,
      message: c.t(CATALOG, 'ui.errAmbiguousAmount', {
        typed: typed.trim(),
        grouped: formatMoneyInput(read.readings.grouped, d, c.locale),
        decimal: formatMoneyInput(read.readings.decimal, d, c.locale),
      }),
    };
  }
  return { ok: false, message: c.t(CATALOG, 'ui.errNotAnAmount') };
}

/** The amount field once the person leaves it: the hub format when readable, as typed when not. */
function normaliseMoneyField(typed: string): string {
  const c = erplora();
  return normaliseMoneyInput(typed, c.currencyDecimals, c.locale, c.currency || undefined);
}

export class ErpPaymentsList extends LitElement {
  static styles = css`
    :host { display:flex; flex-direction:column; height:100%; min-height:0; font-family: system-ui, sans-serif; color: var(--ion-text-color, #1c1b18); }
    /* La vista llena el alto: el data-table ocupa el resto (scroll interno, pie fijo). */
    .page { display:flex; flex-direction:column; min-height:0; flex:1 1 auto; }
    .page > ok-data-table { flex:1 1 auto; min-height:0; }
    /* El alta va en el panel lateral de la tabla (estrecho) → columna, no fila. */
    .form { display:flex; flex-direction:column; gap:.7rem; }
    .form ion-button { align-self:flex-end; }
    .err { color:#d9480f; font-weight:600; }
  `;

  @state() methods: PaymentMethod[] = [];

  /**
   * The three states of the methods read (payments#24), which the alta has to tell apart because
   * their fix is the OPPOSITE of each other: `empty` is solved by creating a method, `error` by
   * retrying. A single «the dropdown is empty» said both at once, and neither out loud.
   */
  @state() methodsState: 'loading' | 'ready' | 'error' = 'loading';

  /** What «New payment» in the panel was refused: painted inside that form, never on the page (pm#513). */
  @state() formError = '';

  /** What a row action («Advance», «Cancel») was refused: no panel is open then, so it goes on the page. */
  @state() pageError = '';

  @state() newMethodId = '';

  @state() newDate = '';

  @state() newAmount = '';

  @state() newBeneficiary = '';

  @state() newConcept = '';

  @state() saving = false;

  @state() tick = 0;

  private ctrl!: ListController<Payment>;

  private unsub?: () => void;

  // Getter (no campo): se re-evalúa en cada render, así los textos cambian con el idioma activo
  // (ADR-0055). El listener `erplora:locale-changed` fuerza el re-render.
  private get columns(): DataTableColumn[] {
    const t = (k: string): string => erplora().t(CATALOG, k);
    return [
    { key: 'reference', header: t('ui.colReference'), sortable: true, filterable: true, filterType: 'text' },
    // A payment date is a calendar DAY: shown as the hub's locale writes it (`13/07/2026`), never
    // ISO. The filter stays a `daterange` — it talks to the query in ISO, which is the only format
    // the column understands; formatting is display, not contract.
    { key: 'payment_date', header: t('ui.colDate'), sortable: true, filterable: true, filterType: 'daterange', format: (r) => formatDate(r.payment_date) },
    { key: 'beneficiary_name', header: t('ui.colBeneficiary'), sortable: true, filterable: true, filterType: 'text' },
    {
      key: 'amount',
      header: t('ui.colAmount'),
      align: 'right',
      sortable: true,
      filterable: true,
      filterType: 'range',
      // The value is MINOR UNITS → `formatMoney` (divides and applies the currency). `toFixed(2)`
      // over the raw integer printed a 250,00 € payment as «25000.00».
      format: (r) => erplora().formatMoney(Number(r.amount || 0), { currency: String(r.currency || '') || undefined }),
    },
    {
      key: 'status',
      header: t('ui.colStatus'),
      sortable: true,
      filterable: true,
      filterType: 'select',
      // The cell used to print the raw domain value (`draft`) while this very filter offered
      // «Borrador»: two lists for one enum, and the table had the untranslated one. Both now come
      // from `PAYMENT_STATUS_KEY`, so they agree by construction.
      format: (r) => enumLabel(PAYMENT_STATUS_KEY, r.status),
      options: enumOptions(PAYMENT_STATUS_KEY),
    },
    ];
  }

  private get actions(): DataTableAction[] {
    const t = (k: string): string => erplora().t(CATALOG, k);
    return [
      { id: 'advance', label: t('ui.actionAdvance'), icon: 'arrow-forward', color: 'primary' },
      { id: 'cancel', label: t('ui.actionCancel'), icon: 'close', color: 'danger' },
    ];
  }

  // Re-render al cambiar el idioma del shell (ADR-0055): los getters `columns`/`actions` y el
  // texto del template se re-evalúan con el nuevo `erplora.locale`.
  private readonly onLocaleChange = (): void => this.requestUpdate();

  // TODO-LIT: componentWillLoad → connectedCallback. Recuerda: connectedCallback se dispara
  // en CADA reconexión al DOM (no solo en el primer montaje). Si la init debe correr una
  // sola vez tras el primer render, considera firstUpdated() en su lugar.
  async connectedCallback() {
    super.connectedCallback();
    window.addEventListener('erplora:locale-changed', this.onLocaleChange);
    this.ctrl = createListController<Payment>(erplora(), 'payments.payments.list', () => this.requestUpdate(), {
      pageSize: 50,
      sort: 'payment_date',
      dir: 'desc',
      // payments#29, pm#501: `amount` is an INTEGER in the minor unit and the column paints it as
      // money of the hub, so the person types the major unit («12»). The SDK scales each edge with
      // the hub's currency decimals before asking; the screen must NOT scale it again.
      moneyFilters: ['amount'],
    });
    await Promise.all([this.ctrl.load(), this.loadMethods()]);
    try {
            // Una suscripción por evento, con su literal EN la llamada (ADR-0127: el extractor
      // de contratos no sigue arrays; el nombre vive donde se usa).
      const offs = [
        erplora().on('payments.payment.created', () => this.ctrl.load()),
        erplora().on('payments.payment.approved', () => this.ctrl.load()),
        erplora().on('payments.payment.sent', () => this.ctrl.load()),
        erplora().on('payments.payment.completed', () => this.ctrl.load()),
        erplora().on('payments.payment.cancelled', () => this.ctrl.load()),
      ];
      this.unsub = () => offs.forEach((off) => off());
    } catch {
      /* sin SDK (preview) → sin reactividad en vivo */
    }
  }

  disconnectedCallback() {
    window.removeEventListener('erplora:locale-changed', this.onLocaleChange);
    super.disconnectedCallback();
    this.unsub?.();
  }

  // Referencia al ok-data-table para cerrar su panel lateral (el alta vive dentro).
  private dataTable(): { open(p?: 'filters' | 'create'): void; close(): void } | null {
    return this.renderRoot.querySelector('ok-data-table') as
      | { open(p?: 'filters' | 'create'): void; close(): void }
      | null;
  }

  /**
   * Reads the payment methods the alta offers, and SAYS which of the three things happened.
   *
   * It used to be an empty `catch` block —«métodos opcionales para el alta»— which swallowed a
   * dropped network, a 403 on permissions, a 422 on the contract and a 502 from the proxy alike. The
   * cashier opened the alta, found the dropdown empty, and nothing on screen —or in the console—
   * told them whether this hub has no methods configured or the list could not be read. The two
   * have opposite fixes, so painting them the same is worse than showing neither.
   *
   * The optional door does the split for us (ADR-0127/0128): `queryOptional` answers `undefined`
   * ONLY when the owner module is absent or deactivated — the one case that IS an absence and has
   * to stay quiet — and re-throws every broken contract, which is what lands in the `error` state.
   */
  private async loadMethods() {
    this.methodsState = 'loading';
    try {
      // hub#1173: `f_is_active` is the DECLARED filter of the `list` block (`is_active`, op `eq`),
      // in the shape the engine reads off the wire. It used to ask for `{ active_only: 1 }`, a name
      // that never existed as a bind — it came from the `PaymentService.list_methods` this was
      // ported from. The engine dropped it in silence and returned the WHOLE list, so the alta
      // offered methods the owner had DEACTIVATED. `queries/methods_list.sql` now warns about it.
      this.methods = (await erplora().queryOptional<PaymentMethod[]>('payments.methods.list', { f_is_active: 1 })) ?? [];
      this.methodsState = 'ready';
    } catch (e) {
      this.methods = [];
      this.methodsState = 'error';
      // El `code` es el contrato estable del rechazo; el mensaje es prosa traducible (ADR-0055).
      // Se registra el código, que es lo único accionable en soporte — un fallo que no se ve no
      // existe, y este estuvo mudo desde que se escribió la pantalla.
      console.error('[payments] payments.methods.list failed', {
        code: (e as { code?: string })?.code ?? 'unknown',
        error: e,
      });
    }
  }

  private async createPayment(ev: Event) {
    ev.preventDefault();
    if (!this.newMethodId || !this.newDate || !this.newBeneficiary.trim()) return;
    this.saving = true;
    this.formError = '';
    this.pageError = ''; // a save is the next thing the person did: an older row refusal is stale (staff#75)
    try {
      const amount = readMoneyField(this.newAmount);
      if (!amount.ok) throw new Error(amount.message);
      // A payment is money going OUT: empty, zero or less is refused here, with its reason. The
      // handler refuses it too, but the hub redacts that into a generic «could not complete» (hub#1074).
      if ((amount.minor ?? 0) <= 0) throw new Error(erplora().t(CATALOG, 'ui.errAmountNotPositive'));
      await erplora().command('payments.payments.create', {
        payment_method_id: this.newMethodId,
        payment_date: this.newDate,
        // Typed major units → MINOR units, at the scale of the hub's currency (ADR-0007/0123).
        // The raw string went to a handler that parses with `money::from_json`, which rounds a
        // stray decimal HALF_UP: a 12,34 € payment was stored as 12 minor units — 0,12 €.
        amount: amount.minor,
        beneficiary_name: this.newBeneficiary.trim(),
        concept: this.newConcept.trim(),
        beneficiary_iban: '',
        supplier_invoice_ref: '',
        currency: 'EUR',
      });
      this.newDate = '';
      this.newAmount = '';
      this.newBeneficiary = '';
      this.newConcept = '';
      this.dataTable()?.close(); // cierra el panel lateral tras crear
      await this.ctrl.load();
    } catch (e) {
      this.formError = e instanceof Error ? e.message : erplora().t(CATALOG, 'ui.errCreate');
    } finally {
      this.saving = false;
    }
  }

  // Thunk en vez de (command, id, extra): ADR-0127 — el literal del contrato vive EN la llamada.
  private async transition(exec: () => Promise<unknown>) {
    this.pageError = '';
    try {
      await exec();
      await this.ctrl.load();
    } catch (e) {
      this.pageError = e instanceof Error ? e.message : erplora().t(CATALOG, 'ui.errTransition');
    }
  }

  private async cancel(payment_id: string) {
    const reason = (globalThis as { prompt?: (m: string) => string | null }).prompt?.(
      erplora().t(CATALOG, 'ui.cancelReasonPrompt'),
    );
    if (!reason || !reason.trim()) return;
    await this.transition(() => erplora().command('payments.payments.cancel', { payment_id, reason: reason.trim() }));
  }

  // Devuelve el THUNK del paso siguiente, con su literal dentro (ADR-0127): el mapa estado→comando
  // sigue en un solo sitio, pero el nombre viaja en la llamada al SDK, donde el extractor lo ve.
  private advanceFor(status: string, payment_id: string): (() => Promise<unknown>) | null {
    switch (status) {
      case 'draft':
        return () => erplora().command('payments.payments.approve', { payment_id });
      case 'approved':
        return () => erplora().command('payments.payments.mark_sent', { payment_id });
      case 'sent':
        return () => erplora().command('payments.payments.mark_completed', { payment_id });
      default:
        return null;
    }
  }

  private onRowAction = (ev: CustomEvent<{ actionId: string; row: Record<string, unknown> }>) => {
    const { actionId, row } = ev.detail;
    const p = row as unknown as Payment;
    if (actionId === 'cancel') {
      if (p.status === 'completed' || p.status === 'cancelled') {
        this.pageError = erplora().t(CATALOG, 'ui.errNoCancel');
        return;
      }
      this.cancel(p.id);
      return;
    }
    if (actionId === 'advance') {
      const run = this.advanceFor(p.status, p.id);
      if (!run) {
        this.pageError = erplora().t(CATALOG, 'ui.errNoTransition');
        return;
      }
      this.transition(run);
    }
  };

  /** pm#513: the refusal appears above the button that was pressed — on a phone that can leave it
   *  off the sheet. Bring it into view when it appears, not again on every keystroke. */
  updated(changed: PropertyValues): void {
    super.updated(changed);
    if (changed.has('formError') && this.formError) void this.revealRefusal('[data-testid="payments-form-error"]');
  }

  /** ok-inline-feedback lays itself out in its own update: scrolled to before it, the box is empty. */
  private async revealRefusal(selector: string): Promise<void> {
    const banner = this.renderRoot.querySelector(selector) as (HTMLElement & { updateComplete?: Promise<unknown> }) | null;
    await banner?.updateComplete;
    banner?.scrollIntoView?.({ block: 'center' });
  }

  render() {
    const t = (k: string): string => erplora().t(CATALOG, k);
    return html`<div class="page">
        ${this.pageError ? html`<ok-inline-feedback data-testid="payments-error" tone="danger" icon="alert-circle-outline">${this.pageError}</ok-inline-feedback>` : nothing}
        ${this.ctrl?.error ? html`<ok-inline-feedback tone="danger" icon="alert-circle-outline">${this.ctrl.error}</ok-inline-feedback>` : nothing}
        <ok-data-table .serverSide=${true} .fill=${true} .addable=${true} .views=${true} .cardTitle=${(row: Record<string, unknown>) => String(row.reference ?? row.beneficiary_name ?? '')} .columns=${this.columns} .rows=${this.ctrl?.rows ?? []} .total=${this.ctrl?.total ?? 0} .page=${this.ctrl?.state.page ?? 0} .pageSize=${this.ctrl?.state.pageSize ?? 50} .sort=${this.ctrl?.state.sort} .sortDir=${this.ctrl?.state.dir ?? 'desc'} .searchable=${true} .searchPlaceholder=${t('ui.searchPlaceholder')} .actions=${this.actions} .emptyMessage=${this.ctrl?.loading ? t('ui.loading') : t('ui.empty')} @rowAction=${this.onRowAction} @pageChange=${(e: CustomEvent<number>) => this.ctrl.setPage(e.detail)} @pageSizeChange=${(e: CustomEvent<number>) => this.ctrl.setPageSize(e.detail)} @sortChange=${(e: CustomEvent<{ sort: string; dir: 'asc' | 'desc' }>) => this.ctrl.setSort(e.detail.sort, e.detail.dir)} @searchChange=${(e: CustomEvent<string>) => this.ctrl.setSearch(e.detail)} @filterChange=${(e: CustomEvent<{ col: string; value: unknown }>) => this.ctrl.setFilter(e.detail.col, e.detail.value)}>
          <!-- Alta: se proyecta SIEMPRE (aunque el panel esté cerrado). Si solo se renderizara con el
               panel abierto, el «+» de la barra desplegaría un panel vacío. -->
          <form slot="create" class="form" @submit=${(e: Event) => this.createPayment(e)}>
            <!-- payments#24 · los tres estados del desplegable de métodos, que NO se pintan igual:
                 se pudo leer y no hay ninguno (crear uno) · no se pudo leer (reintentar) ·
                 todavía se está leyendo (esperar). El silencio los confundía todos con el primero. -->
            ${this.methodsState === 'error'
              ? html`<ok-inline-feedback tone="danger" icon="alert-circle-outline">
                  ${t('ui.errMethods')}
                  <ion-button slot="actions" data-act="retry-methods" type="button" size="small" fill="outline" @click=${() => void this.loadMethods()}>${t('ui.retry')}</ion-button>
                </ok-inline-feedback>`
              : nothing}
            ${this.methodsState === 'ready' && this.methods.length === 0
              ? html`<ok-inline-feedback tone="warning">${t('ui.emptyMethods')}</ok-inline-feedback>`
              : nothing}
            <ion-select fill="outline" label-placement="floating" label=${t('ui.colMethod')} ?disabled=${this.methodsState !== 'ready' || this.methods.length === 0} placeholder=${this.methodsState === 'loading' ? t('ui.loading') : t('ui.phMethod')} .value=${this.newMethodId} @ionChange=${(e: any) => (this.newMethodId = e.target.value)}>${this.methods.map((m) => html`<ion-select-option .value=${m.id}>${m.name}</ion-select-option>`)}</ion-select>
            <ion-input fill="outline" label-placement="floating" label=${t('ui.colDate')} type="date" .value=${this.newDate} @ionInput=${(e: any) => (this.newDate = e.target.value)}></ion-input>
            <ion-input data-testid="payments-new-amount" fill="outline" label-placement="floating" label=${t('ui.colAmount')} type="text" inputmode="decimal" .value=${this.newAmount} @ionInput=${(e: any) => (this.newAmount = e.target.value)} @ionBlur=${() => (this.newAmount = normaliseMoneyField(this.newAmount))}></ion-input>
            <ion-input fill="outline" label-placement="floating" label=${t('ui.colBeneficiary')} .value=${this.newBeneficiary} @ionInput=${(e: any) => (this.newBeneficiary = e.target.value)}></ion-input>
            <ion-input fill="outline" label-placement="floating" label=${t('ui.colConcept')} .value=${this.newConcept} @ionInput=${(e: any) => (this.newConcept = e.target.value)}></ion-input>
            <!-- pm#513: the refusal travels WITH the form — under 834 px the panel is a full-screen
                 sheet and a notice on the page underneath it is never seen. -->
            ${this.formError ? html`<ok-inline-feedback data-testid="payments-form-error" tone="danger" icon="alert-circle-outline">${this.formError}</ok-inline-feedback>` : nothing}
            <ion-button type="submit" ?disabled=${this.saving || !this.newMethodId || !this.newDate || !this.newAmount.trim() || !this.newBeneficiary}>${this.saving ? t('ui.saving') : t('ui.newPayment')}</ion-button>
          </form>
        </ok-data-table>
      </div>`;
  }
}

define('erp-payments-list', ErpPaymentsList);
