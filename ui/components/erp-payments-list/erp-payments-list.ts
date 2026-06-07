import { LitElement, html, css, nothing } from 'lit';
import { state } from 'lit/decorators.js';
import { define } from '@erplora/outfitkit/define';
import '@erplora/outfitkit/ok-data-table';
import type { DataTableColumn, DataTableAction } from '@erplora/outfitkit';
import { createListController } from '@erplora/module-sdk';
import type { ListController, ListClient, ListParams, ListPage } from '@erplora/module-sdk';

interface ErploraClientLike extends ListClient {
  query<T = unknown>(name: string, params?: Record<string, unknown>): Promise<T>;
  queryPage<R = unknown>(name: string, params: ListParams): Promise<ListPage<R>>;
  command<T = unknown>(name: string, payload?: Record<string, unknown>): Promise<T>;
  on(event: string, cb: (payload: unknown) => void): () => void;
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
    :host { display:block; font-family: system-ui, sans-serif; color: var(--ion-text-color, #1c1b18); }
    header { display:flex; gap:.5rem; align-items:center; margin-bottom:.75rem; flex-wrap:wrap; }
    h2 { margin:0; font-size:1.15rem; flex:1; }
    .form { display:flex; gap:.5rem; flex-wrap:wrap; align-items:end; margin:.5rem 0 1rem; }
    .form ion-input, .form ion-select { --background:var(--surface-2,#f7f4ec); border:1px solid var(--line,#e7e2d6); border-radius:8px; min-width:8rem; }
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

  private columns: DataTableColumn[] = [
    { key: 'reference', header: 'Referencia', sortable: true, filterable: true, filterType: 'text' },
    { key: 'payment_date', header: 'Fecha', sortable: true, filterable: true, filterType: 'daterange', format: (r) => String(r.payment_date ?? '').slice(0, 10) },
    { key: 'beneficiary_name', header: 'Beneficiario', sortable: true, filterable: true, filterType: 'text' },
    {
      key: 'amount',
      header: 'Importe',
      align: 'right',
      sortable: true,
      filterable: true,
      filterType: 'range',
      format: (r) => `${Number(r.amount).toFixed(2)} ${r.currency ?? ''}`.trim(),
    },
    {
      key: 'status',
      header: 'Estado',
      sortable: true,
      filterable: true,
      filterType: 'select',
      options: [
        { value: 'draft', label: 'Draft' },
        { value: 'approved', label: 'Approved' },
        { value: 'sent', label: 'Sent' },
        { value: 'completed', label: 'Completed' },
        { value: 'cancelled', label: 'Cancelled' },
      ],
    },
  ];

  private actions: DataTableAction[] = [
    { id: 'advance', label: 'Avanzar', icon: 'arrow-forward', color: 'primary' },
    { id: 'cancel', label: 'Cancelar', icon: 'close', color: 'danger' },
  ];

  // TODO-LIT: componentWillLoad → connectedCallback. Recuerda: connectedCallback se dispara
  // en CADA reconexión al DOM (no solo en el primer montaje). Si la init debe correr una
  // sola vez tras el primer render, considera firstUpdated() en su lugar.
  async connectedCallback() {
    super.connectedCallback();
    this.ctrl = createListController<Payment>(erplora(), 'payments.payments.list', () => this.requestUpdate(), {
      pageSize: 50,
      sort: 'payment_date',
      dir: 'desc',
    });
    await Promise.all([this.ctrl.load(), this.loadMethods()]);
    try {
      const events = [
        'payments.payment.created',
        'payments.payment.approved',
        'payments.payment.sent',
        'payments.payment.completed',
        'payments.payment.cancelled',
      ];
      const offs = events.map((e) => erplora().on(e, () => this.ctrl.load()));
      this.unsub = () => offs.forEach((off) => off());
    } catch {
      /* sin SDK (preview) → sin reactividad en vivo */
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.unsub?.();
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
      await this.ctrl.load();
    } catch (e) {
      this.formError = e instanceof Error ? e.message : 'No se pudo crear el pago';
    } finally {
      this.saving = false;
    }
  }

  private async transition(command: string, payment_id: string, extra?: Record<string, unknown>) {
    this.formError = '';
    try {
      await erplora().command(command, { payment_id, ...(extra ?? {}) });
      await this.ctrl.load();
    } catch (e) {
      this.formError = e instanceof Error ? e.message : 'Transición no permitida';
    }
  }

  private async cancel(payment_id: string) {
    const reason = (globalThis as { prompt?: (m: string) => string | null }).prompt?.(
      'Motivo de cancelación:',
    );
    if (!reason || !reason.trim()) return;
    await this.transition('payments.payments.cancel', payment_id, { reason: reason.trim() });
  }

  private advanceCommandFor(status: string): string | null {
    switch (status) {
      case 'draft':
        return 'payments.payments.approve';
      case 'approved':
        return 'payments.payments.mark_sent';
      case 'sent':
        return 'payments.payments.mark_completed';
      default:
        return null;
    }
  }

  private onRowAction = (ev: CustomEvent<{ actionId: string; row: Record<string, unknown> }>) => {
    const { actionId, row } = ev.detail;
    const p = row as unknown as Payment;
    if (actionId === 'cancel') {
      if (p.status === 'completed' || p.status === 'cancelled') {
        this.formError = 'El pago ya no admite cancelación.';
        return;
      }
      this.cancel(p.id);
      return;
    }
    if (actionId === 'advance') {
      const command = this.advanceCommandFor(p.status);
      if (!command) {
        this.formError = 'El pago no admite más transiciones.';
        return;
      }
      this.transition(command, p.id);
    }
  };

  render() {
    return html`<div>
        <header>
          <h2>Pagos salientes</h2>
        </header>
        <form class="form" @submit=${(e) => this.createPayment(e)}>
          <ion-select placeholder="Método…" .value=${this.newMethodId} @ionChange=${(e: any) => (this.newMethodId = e.target.value)}>${this.methods.map((m) => html`<ion-select-option .value=${m.id}>${m.name}</ion-select-option>`)}</ion-select>
          <ion-input type="date" .value=${this.newDate} @ionInput=${(e: any) => (this.newDate = e.target.value)}></ion-input>
          <ion-input type="number" step="0.01" placeholder="Importe" .value=${this.newAmount} @ionInput=${(e: any) => (this.newAmount = e.target.value)}></ion-input>
          <ion-input placeholder="Beneficiario" .value=${this.newBeneficiary} @ionInput=${(e: any) => (this.newBeneficiary = e.target.value)}></ion-input>
          <ion-input placeholder="Concepto" .value=${this.newConcept} @ionInput=${(e: any) => (this.newConcept = e.target.value)}></ion-input>
          <ion-button type="submit" size="small" ?disabled=${this.saving || !this.newMethodId || !this.newDate || !this.newBeneficiary}>${this.saving ? 'Guardando…' : 'Nuevo pago'}</ion-button>
        </form>
        ${this.formError ? html`<p class="err">${this.formError}</p>` : nothing}
        ${this.ctrl?.error ? html`<p class="err">${this.ctrl.error}</p>` : nothing}
        <ok-data-table .serverSide=${true} .columns=${this.columns} .rows=${this.ctrl?.rows ?? []} .total=${this.ctrl?.total ?? 0} .page=${this.ctrl?.state.page ?? 0} .pageSize=${this.ctrl?.state.pageSize ?? 50} .sort=${this.ctrl?.state.sort} .sortDir=${this.ctrl?.state.dir ?? 'desc'} .searchable=${true} .searchPlaceholder=${"Buscar referencia o beneficiario…"} .actions=${this.actions} .emptyMessage=${this.ctrl?.loading ? 'Cargando…' : 'Sin pagos.'} @rowAction=${this.onRowAction} @pageChange=${(e: CustomEvent<number>) => this.ctrl.setPage(e.detail)} @sortChange=${(e: CustomEvent<{ sort: string; dir: 'asc' | 'desc' }>) => this.ctrl.setSort(e.detail.sort, e.detail.dir)} @searchChange=${(e: CustomEvent<string>) => this.ctrl.setSearch(e.detail)} @filterChange=${(e: CustomEvent<{ col: string; value: unknown }>) => this.ctrl.setFilter(e.detail.col, e.detail.value)}></ok-data-table>
      </div>`;
  }
}

define('erp-payments-list', ErpPaymentsList);
