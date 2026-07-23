import { LitElement, html, css, nothing } from 'lit';
import { state } from 'lit/decorators.js';
import { define } from '@erplora/outfitkit/define';
import '@erplora/outfitkit/ok-inline-feedback';
import '@erplora/outfitkit/ok-data-table';
import type { DataTableColumn, DataTableAction } from '@erplora/outfitkit';
import { createListController } from '@erplora/module-sdk';
import type { ListController, ListClient, ListParams, ListPage } from '@erplora/module-sdk';
// Catálogo i18n del módulo (ADR-0055): esbuild inlinea estos JSON en el `dist` del WC. Los textos
// internos se resuelven con `erplora.t(CATALOG, 'ui.clave')` (idioma activo, fallback locale→en→clave).
import esLocale from '../../../locales/es.json';
import enLocale from '../../../locales/en.json';
const CATALOG: Record<string, unknown> = { es: esLocale, en: enLocale };

interface ErploraClientLike extends ListClient {
  query<T = unknown>(name: string, params?: Record<string, unknown>): Promise<T>;
  queryPage<R = unknown>(name: string, params: ListParams): Promise<ListPage<R>>;
  command<T = unknown>(name: string, payload?: Record<string, unknown>): Promise<T>;
  on(event: string, cb: (payload: unknown) => void): () => void;
  /** i18n del módulo (ADR-0055): idioma activo + traducción del catálogo `ui`. */
  locale: string;
  t(catalog: Record<string, unknown>, key: string, params?: Record<string, unknown>): string;
}

interface Payment {
  id: string;
  reference: string;
  payment_method_id: string;
  payment_date: string;
  amount: string;
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

  @state() formError = '';

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
    { key: 'payment_date', header: t('ui.colDate'), sortable: true, filterable: true, filterType: 'daterange', format: (r) => String(r.payment_date ?? '').slice(0, 10) },
    { key: 'beneficiary_name', header: t('ui.colBeneficiary'), sortable: true, filterable: true, filterType: 'text' },
    {
      key: 'amount',
      header: t('ui.colAmount'),
      align: 'right',
      sortable: true,
      filterable: true,
      filterType: 'range',
      format: (r) => `${Number(r.amount).toFixed(2)} ${r.currency ?? ''}`.trim(),
    },
    {
      key: 'status',
      header: t('ui.colStatus'),
      sortable: true,
      filterable: true,
      filterType: 'select',
      options: [
        { value: 'draft', label: t('ui.statusDraft') },
        { value: 'approved', label: t('ui.statusApproved') },
        { value: 'sent', label: t('ui.statusSent') },
        { value: 'completed', label: t('ui.statusCompleted') },
        { value: 'cancelled', label: t('ui.statusCancelled') },
      ],
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

  private async loadMethods() {
    try {
      this.methods = (await erplora().query<PaymentMethod[]>('payments.methods.list', { active_only: 1 })) ?? [];
    } catch { /* métodos opcionales para el alta */ }
  }

  private async createPayment(ev: Event) {
    ev.preventDefault();
    if (!this.newMethodId || !this.newDate || !this.newBeneficiary.trim()) return;
    this.saving = true;
    this.formError = '';
    try {
      await erplora().command('payments.payments.create', {
        payment_method_id: this.newMethodId,
        payment_date: this.newDate,
        amount: this.newAmount,
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
    this.formError = '';
    try {
      await exec();
      await this.ctrl.load();
    } catch (e) {
      this.formError = e instanceof Error ? e.message : erplora().t(CATALOG, 'ui.errTransition');
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
        this.formError = erplora().t(CATALOG, 'ui.errNoCancel');
        return;
      }
      this.cancel(p.id);
      return;
    }
    if (actionId === 'advance') {
      const run = this.advanceFor(p.status, p.id);
      if (!run) {
        this.formError = erplora().t(CATALOG, 'ui.errNoTransition');
        return;
      }
      this.transition(run);
    }
  };

  render() {
    const t = (k: string): string => erplora().t(CATALOG, k);
    return html`<div class="page">
        ${this.formError ? html`<ok-inline-feedback tone="danger" icon="alert-circle-outline">${this.formError}</ok-inline-feedback>` : nothing}
        ${this.ctrl?.error ? html`<ok-inline-feedback tone="danger" icon="alert-circle-outline">${this.ctrl.error}</ok-inline-feedback>` : nothing}
        <ok-data-table .serverSide=${true} .fill=${true} .addable=${true} .columns=${this.columns} .rows=${this.ctrl?.rows ?? []} .total=${this.ctrl?.total ?? 0} .page=${this.ctrl?.state.page ?? 0} .pageSize=${this.ctrl?.state.pageSize ?? 50} .sort=${this.ctrl?.state.sort} .sortDir=${this.ctrl?.state.dir ?? 'desc'} .searchable=${true} .searchPlaceholder=${t('ui.searchPlaceholder')} .actions=${this.actions} .emptyMessage=${this.ctrl?.loading ? t('ui.loading') : t('ui.empty')} @rowAction=${this.onRowAction} @pageChange=${(e: CustomEvent<number>) => this.ctrl.setPage(e.detail)} @pageSizeChange=${(e: CustomEvent<number>) => this.ctrl.setPageSize(e.detail)} @sortChange=${(e: CustomEvent<{ sort: string; dir: 'asc' | 'desc' }>) => this.ctrl.setSort(e.detail.sort, e.detail.dir)} @searchChange=${(e: CustomEvent<string>) => this.ctrl.setSearch(e.detail)} @filterChange=${(e: CustomEvent<{ col: string; value: unknown }>) => this.ctrl.setFilter(e.detail.col, e.detail.value)}>
          <!-- Alta: se proyecta SIEMPRE (aunque el panel esté cerrado). Si solo se renderizara con el
               panel abierto, el «+» de la barra desplegaría un panel vacío. -->
          <form slot="create" class="form" @submit=${(e: Event) => this.createPayment(e)}>
            <ion-select fill="outline" label-placement="floating" label=${t('ui.colMethod')} placeholder=${t('ui.phMethod')} .value=${this.newMethodId} @ionChange=${(e: any) => (this.newMethodId = e.target.value)}>${this.methods.map((m) => html`<ion-select-option .value=${m.id}>${m.name}</ion-select-option>`)}</ion-select>
            <ion-input fill="outline" label-placement="floating" label=${t('ui.colDate')} type="date" .value=${this.newDate} @ionInput=${(e: any) => (this.newDate = e.target.value)}></ion-input>
            <ion-input fill="outline" label-placement="floating" label=${t('ui.colAmount')} type="number" step="0.01" .value=${this.newAmount} @ionInput=${(e: any) => (this.newAmount = e.target.value)}></ion-input>
            <ion-input fill="outline" label-placement="floating" label=${t('ui.colBeneficiary')} .value=${this.newBeneficiary} @ionInput=${(e: any) => (this.newBeneficiary = e.target.value)}></ion-input>
            <ion-input fill="outline" label-placement="floating" label=${t('ui.colConcept')} .value=${this.newConcept} @ionInput=${(e: any) => (this.newConcept = e.target.value)}></ion-input>
            <ion-button type="submit" ?disabled=${this.saving || !this.newMethodId || !this.newDate || !this.newBeneficiary}>${this.saving ? t('ui.saving') : t('ui.newPayment')}</ion-button>
          </form>
        </ok-data-table>
      </div>`;
  }
}

define('erp-payments-list', ErpPaymentsList);
