// Contract of the module's enum/date catalogue (payments#20).
//
// This file exists because the `ESTADO` column printed `draft` while the filter of that very column
// offered «Borrador»: two sources for one enum. The catalogue below is the single one, so what the
// cell says and what the picker offers are the same string BY CONSTRUCTION, not by two people
// remembering to update two lists. The same mistake, and the same fix, as staff#37.
import { beforeEach, describe, expect, it } from 'vitest';

import esLocale from '../../locales/es.json';
import { PAYMENT_STATUS_KEY, enumLabel, enumOptions, formatDate } from './enums';

const es = (esLocale as { ui: Record<string, string> }).ui;

function shellSpeaking(locale: string) {
  (globalThis as Record<string, unknown>).erplora = {
    locale,
    // The real resolution the shell does (ADR-0055): `ui.key` against the catalogue of the active
    // language, falling back to the key itself.
    t: (catalog: Record<string, unknown>, key: string) => {
      const lang = (catalog[locale] ?? catalog.en) as Record<string, Record<string, string>>;
      const [section, name] = key.split('.');
      return lang?.[section]?.[name] ?? key;
    },
  };
}

beforeEach(() => shellSpeaking('es'));

describe('the status catalogue is the one both the cell and the filter read', () => {
  it('covers the five states the module can be in, and no others', () => {
    expect(Object.keys(PAYMENT_STATUS_KEY).sort()).toEqual(
      ['approved', 'cancelled', 'completed', 'draft', 'sent'],
    );
  });

  it('every state has its Spanish label — a key printed raw is the bug coming back', () => {
    for (const [value, key] of Object.entries(PAYMENT_STATUS_KEY)) {
      const label = enumLabel(PAYMENT_STATUS_KEY, value);
      expect(label, `«${value}» resolves to the i18n key itself: ${key} is missing from es.json`).not.toBe(key);
      expect(label).toBe(es[key.split('.')[1]]);
    }
  });

  it('`draft` reads «Borrador», which is the whole point', () => {
    expect(enumLabel(PAYMENT_STATUS_KEY, 'draft')).toBe('Borrador');
  });

  it('a value the catalogue does not know is printed AS IS, never blank', () => {
    // A hub running a module newer than its catalogue must still see the payment.
    expect(enumLabel(PAYMENT_STATUS_KEY, 'settled')).toBe('settled');
    expect(enumLabel(PAYMENT_STATUS_KEY, null)).toBe('');
    expect(enumLabel(PAYMENT_STATUS_KEY, undefined)).toBe('');
  });

  it('the options of the filter carry the SAME labels the cell prints', () => {
    for (const opt of enumOptions(PAYMENT_STATUS_KEY)) {
      expect(opt.label).toBe(enumLabel(PAYMENT_STATUS_KEY, opt.value));
    }
  });

  it('the labels follow the active language, resolved at call time and not at import', () => {
    shellSpeaking('en');
    expect(enumLabel(PAYMENT_STATUS_KEY, 'draft')).toBe('Draft');
  });
});

describe('a payment date is a calendar day, and it is read in the hub locale', () => {
  it('an ISO day is shown as the locale writes it', () => {
    expect(formatDate('2026-07-13')).toBe('13/07/2026');
  });

  it('the date half of a timestamp is enough', () => {
    expect(formatDate('2026-07-13T22:30:00+00:00')).toBe('13/07/2026');
  });

  it('it is formatted in UTC, so the day never slides west of Greenwich', () => {
    // 1 January is the case that would show 31/12 if this were formatted in a negative-offset zone.
    expect(formatDate('2026-01-01')).toBe('01/01/2026');
  });

  it('English writes the same day its own way — nothing is hardcoded', () => {
    shellSpeaking('en');
    expect(formatDate('2026-07-13')).toBe('07/13/2026');
  });

  it('anything that is not a date comes back untouched instead of losing the row', () => {
    expect(formatDate('')).toBe('');
    expect(formatDate(null)).toBe('');
    expect(formatDate('no-es-una-fecha')).toBe('no-es-una-fecha');
    expect(formatDate('2026-13-45')).toBe('2026-13-45');
  });
});
