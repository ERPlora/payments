// The module's enums and dates, as the USER reads them (payments#20).
//
// The `ESTADO` column printed the raw domain value (`draft`) while the `<ion-select>` of its own
// filter, right next to it, offered «Borrador» for the very same field: two sources for one enum,
// and the table — which is what people actually read — had the untranslated one. Same shape as
// staff#37, closed the same way: the catalogue of every closed domain of this module lives HERE,
// and both the cell and the picker read from it. There is nowhere left to drift to.
//
// The keys are the module's public values (its schemas and its SQL); the labels are i18n keys
// resolved at RENDER time through `erplora.t()` (ADR-0055), never at module load: when this file is
// imported the shell has not published the client yet, and the user can change language later.
import esLocale from '../../locales/es.json';
import enLocale from '../../locales/en.json';

const CATALOG: Record<string, unknown> = { es: esLocale, en: enLocale };

interface Translator {
  locale: string;
  t(catalog: Record<string, unknown>, key: string, params?: Record<string, unknown>): string;
}

function erplora(): Translator {
  const c = (globalThis as { erplora?: Translator }).erplora;
  if (!c) throw new Error('erplora SDK no inicializado por el shell');
  return c;
}

/**
 * `payments_payment.status` — the lifecycle of an outgoing payment: the enum of
 * `schemas/payment_create.json` plus where `payments.payments.advance` / `.cancel` can take it.
 */
export const PAYMENT_STATUS_KEY: Record<string, string> = {
  draft: 'ui.statusDraft',
  approved: 'ui.statusApproved',
  sent: 'ui.statusSent',
  completed: 'ui.statusCompleted',
  cancelled: 'ui.statusCancelled',
};

/**
 * The label of `value` in the active language.
 *
 * A value the catalogue does not know is printed AS IS: a hub running a module version newer than
 * its catalogue must still show the row, not a blank cell. This screen says what left the bank
 * account, and a missing translation is not a reason to hide a payment.
 */
export function enumLabel(keys: Record<string, string>, value: unknown): string {
  const raw = value == null ? '' : String(value);
  const key = keys[raw];
  return key ? erplora().t(CATALOG, key) : raw;
}

/** The options of a closed domain, for an `<ion-select>` or a column filter — the same labels the
 *  cell prints, by construction. */
export function enumOptions(keys: Record<string, string>): { value: string; label: string }[] {
  return Object.keys(keys).map((value) => ({ value, label: enumLabel(keys, value) }));
}

/**
 * An ISO date (`YYYY-MM-DD`, or the date half of a timestamp) in the hub's locale: `13/07/2026` in
 * `es`, not `2026-07-13`. Formatted in **UTC** on purpose — `payment_date` is a calendar day, not
 * an instant, and formatting it in the browser's zone moves it a day off west of Greenwich.
 *
 * Anything that is not an ISO date comes back untouched: an unreadable value is worth showing as it
 * is, and it is never worth losing the row over.
 */
export function formatDate(value: unknown): string {
  const raw = value == null ? '' : String(value);
  const iso = raw.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return raw;
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return raw;
  try {
    return new Intl.DateTimeFormat(erplora().locale || 'es', {
      day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC',
    }).format(d);
  } catch {
    return iso; // an unknown locale is not a reason to lose the date
  }
}
