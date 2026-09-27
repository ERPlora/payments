import { it, expect } from 'vitest';
import { checkMoneyDisplay } from '@erplora/module-toolkit/money-display-guard';

// GUARD (pm#289, shared since pm#505/pm#508): money on screen is never formatted by hand in this
// module, and OutfitKit comes in by entry point, never as a value from the barrel.
//
// The rules live in `@erplora/module-toolkit/money-display-guard` (one piece for every module,
// tested there against its own positives); this test only says what is specific to Payments:
//
// * witnesses — the only amount this module paints (the Amount column of the payments list) goes
//   through the shell's formatter. It counts the CALL, not the name: the screen also declares
//   `formatMoney(minor: number, …)` in its `erplora()` interface, and a scan over empty or
//   over-stripped content must not stay green on that declaration (rv-combos-22). The label helper
//   of `lib/` is a witness too, so `lib/` provably stays in what the detector reads (rv-taxes-78).
// * notDisplay — none: the Amount column goes through `erplora().formatMoney(minor)`, and the
//   new-payment form and the amount range filter parse with `majorToMinor(…, currencyDecimals)`.
//   Add an entry (`'file: exact code line'` → why) only with the reason it is not a screen amount.
// * outfitkitImporters — the payments list imports OutfitKit (entry points + types), so the barrel
//   scan provably read it (rv-pricing-53).
it('money on screen goes through the shared formatter and OutfitKit by entry point (pm#289)', () => {
  expect(
    checkMoneyDisplay({
      from: import.meta.url,
      witnesses: {
        'components/erp-payments-list/erp-payments-list.ts': { text: 'erplora().formatMoney(', atLeast: 1 },
        'lib/enums.ts': { text: 'export function enumLabel(', atLeast: 1 },
      },
      notDisplay: {},
      outfitkitImporters: ['components/erp-payments-list/erp-payments-list.ts'],
    }),
  ).toEqual([]);
});
