import { Component, State, h } from '@stencil/core';
// Importa el DataTable compartido (Stencil) para que se auto-registre y esbuild
// lo empaquete dentro del bundle del módulo. El shell provee los `ion-*`.
import '../../../../_shared/ui/components/data-table/data-table';
import type { DataTableColumn, DataTableAction } from '../../../../_shared/ui/components/data-table/data-table';

// Web Component del módulo `payments` (Stencil). Mini-app: lista de pagos salientes +
// filtro por estado + alta rápida de pago (draft) + transiciones de flujo
// (approve / sent / completed / cancel). Es la pieza `ui.entry` que el shell carga
// en runtime (modules/payments/dist/payments.esm.js).
//
// 90% de la lógica vive en Rust/WASM: este componente NO toca la BD; llama al SDK
// (erplora.query/command/on). Toda escritura la valida y ejecuta el runtime
// (la creación de pago + nº atómico es un handler WASM Tier 2; ver WASM-TODO.md).
// El cliente se obtiene de `globalThis.erplora` (lo monta el shell en el boot,
// eligiendo HttpWsTransport en cloud o IpcTransport en Tauri).
//
// El listado usa el DataTable compartido + Ionic; las transiciones de flujo van
// por botones de fila (evento `rowAction`) y el formulario de alta usa `ion-*`.

interface ErploraClientLike {
  query<T = unknown>(name: string, params?: Record<string, unknown>): Promise<T>;
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

@Component({
  tag: 'erp-payments-list',
  shadow: true,
  styles: `
    :host { display:block; font-family: system-ui, sans-serif; color: var(--ion-text-color, #1c1b18); }
    header { display:flex; gap:.5rem; align-items:center; margin-bottom:.75rem; flex-wrap:wrap; }
    h2 { margin:0; font-size:1.15rem; flex:1; }
    .form { display:flex; gap:.5rem; flex-wrap:wrap; align-items:end; margin:.5rem 0 1rem; }
    .form ion-input, .form ion-select { --background:var(--surface-2,#f7f4ec); border:1px solid var(--line,#e7e2d6); border-radius:8px; min-width:8rem; }
    .toolbar { display:flex; gap:.5rem; align-items:center; }
    .err { color:#d9480f; font-weight:600; }
  `,
})
export class ErpPaymentsList {
  @State() payments: Payment[] = [];
  @State() methods: PaymentMethod[] = [];
  @State() loading = true;
  @State() error = '';
  @State() statusFilter = '';
  // formulario de alta
  @State() newMethodId = '';
  @State() newDate = '';
  @State() newAmount = '';
  @State() newBeneficiary = '';
  @State() newConcept = '';
  @State() saving = false;

  private unsub?: () => void;

  private columns: DataTableColumn[] = [
    { key: 'reference', header: 'Referencia' },
    { key: 'payment_date', header: 'Fecha', format: (r) => String(r.payment_date ?? '').slice(0, 10) },
    { key: 'beneficiary_name', header: 'Beneficiario' },
    {
      key: 'amount',
      header: 'Importe',
      align: 'right',
      format: (r) => `${Number(r.amount).toFixed(2)} ${r.currency ?? ''}`.trim(),
    },
    { key: 'status', header: 'Estado' },
  ];

  // Acciones por fila. Son genéricas (avanzar/cancelar); el handler resuelve el
  // comando concreto según el estado de la fila. data-table renderiza los mismos
  // botones para todas las filas; las transiciones inválidas las rechaza el runtime.
  private actions: DataTableAction[] = [
    { id: 'advance', label: 'Avanzar', icon: 'arrow-forward', color: 'primary' },
    { id: 'cancel', label: 'Cancelar', icon: 'close', color: 'danger' },
  ];

  async componentWillLoad() {
    await this.refresh();
    // Reactividad: cuando el runtime emite un cambio de pago, recargamos la lista.
    try {
      const events = [
        'payments.payment.created',
        'payments.payment.approved',
        'payments.payment.sent',
        'payments.payment.completed',
        'payments.payment.cancelled',
      ];
      const offs = events.map((e) => erplora().on(e, () => this.refresh()));
      this.unsub = () => offs.forEach((off) => off());
    } catch {
      /* sin SDK (preview) → sin reactividad en vivo */
    }
  }

  disconnectedCallback() {
    this.unsub?.();
  }

  private async refresh() {
    this.loading = true;
    this.error = '';
    try {
      const [payments, methods] = await Promise.all([
        erplora().query<Payment[]>('payments.payments.list', { status: this.statusFilter }),
        erplora().query<PaymentMethod[]>('payments.methods.list', { active_only: 1 }),
      ]);
      this.payments = payments ?? [];
      this.methods = methods ?? [];
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'Error cargando pagos';
    } finally {
      this.loading = false;
    }
  }

  private async createPayment(ev: Event) {
    ev.preventDefault();
    if (!this.newMethodId || !this.newDate || !this.newBeneficiary.trim()) return;
    this.saving = true;
    this.error = '';
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
      await this.refresh();
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'No se pudo crear el pago';
    } finally {
      this.saving = false;
    }
  }

  private async transition(command: string, payment_id: string, extra?: Record<string, unknown>) {
    this.error = '';
    try {
      await erplora().command(command, { payment_id, ...(extra ?? {}) });
      await this.refresh();
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'Transición no permitida';
    }
  }

  private async cancel(payment_id: string) {
    const reason = (globalThis as { prompt?: (m: string) => string | null }).prompt?.(
      'Motivo de cancelación:',
    );
    if (!reason || !reason.trim()) return;
    await this.transition('payments.payments.cancel', payment_id, { reason: reason.trim() });
  }

  // Resuelve qué comando "avanza" un pago según su estado actual.
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
        this.error = 'El pago ya no admite cancelación.';
        return;
      }
      this.cancel(p.id);
      return;
    }
    if (actionId === 'advance') {
      const command = this.advanceCommandFor(p.status);
      if (!command) {
        this.error = 'El pago no admite más transiciones.';
        return;
      }
      this.transition(command, p.id);
    }
  };

  render() {
    return (
      <div>
        <header>
          <h2>Pagos salientes</h2>
        </header>

        <form class="form" onSubmit={(e) => this.createPayment(e)}>
          <ion-select
            placeholder="Método…"
            value={this.newMethodId}
            onIonChange={(e: any) => (this.newMethodId = e.target.value)}
          >
            {this.methods.map((m) => (
              <ion-select-option value={m.id} key={m.id}>
                {m.name}
              </ion-select-option>
            ))}
          </ion-select>
          <ion-input
            type="date"
            value={this.newDate}
            onIonInput={(e: any) => (this.newDate = e.target.value)}
          />
          <ion-input
            type="number"
            step="0.01"
            placeholder="Importe"
            value={this.newAmount}
            onIonInput={(e: any) => (this.newAmount = e.target.value)}
          />
          <ion-input
            placeholder="Beneficiario"
            value={this.newBeneficiary}
            onIonInput={(e: any) => (this.newBeneficiary = e.target.value)}
          />
          <ion-input
            placeholder="Concepto"
            value={this.newConcept}
            onIonInput={(e: any) => (this.newConcept = e.target.value)}
          />
          <ion-button
            type="submit"
            size="small"
            disabled={this.saving || !this.newMethodId || !this.newDate || !this.newBeneficiary}
          >
            {this.saving ? 'Guardando…' : 'Nuevo pago'}
          </ion-button>
        </form>

        {this.error && <p class="err">{this.error}</p>}

        <data-table
          columns={this.columns}
          rows={this.payments as unknown as Record<string, unknown>[]}
          actions={this.actions}
          searchKeys={['reference', 'beneficiary_name', 'concept']}
          searchPlaceholder="Buscar referencia o beneficiario…"
          emptyMessage={this.loading ? 'Cargando…' : 'Sin pagos.'}
          onRowAction={this.onRowAction}
        >
          <div class="toolbar" slot="toolbar">
            <ion-select
              placeholder="Todos los estados"
              value={this.statusFilter}
              interface="popover"
              onIonChange={(e: any) => {
                this.statusFilter = e.target.value;
                this.refresh();
              }}
            >
              <ion-select-option value="">Todos los estados</ion-select-option>
              <ion-select-option value="draft">Draft</ion-select-option>
              <ion-select-option value="approved">Approved</ion-select-option>
              <ion-select-option value="sent">Sent</ion-select-option>
              <ion-select-option value="completed">Completed</ion-select-option>
              <ion-select-option value="cancelled">Cancelled</ion-select-option>
            </ion-select>
          </div>
        </data-table>
      </div>
    );
  }
}
