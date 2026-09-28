# Payments — Screens

The module contributes one tab to the hub navigation: **Payments**.

## Payments

Every recorded payment with its status and amount (`payments.payments.list`, 50 rows per page).
Requires `payments.view_payment`.

- **Search** by reference, beneficiary name or supplier invoice reference.
- **Sort** by reference, method, date, amount, currency, beneficiary, IBAN, concept, status or
  supplier invoice reference.
- **Filter** by any of those, with a range on the date and on the amount.

Open a row for the full detail (`payments.payments.get`). The table refreshes by itself whenever any
payment event arrives.

### Register a payment

1. Press to create a payment.
2. Pick the **payment method** — required.
3. Set the **payment date** — required, as `YYYY-MM-DD` or a full timestamp.
4. Enter the **amount** — required, greater than zero, in cents.
5. Enter the **beneficiary name** — required; it is stored trimmed.
6. Optionally add the beneficiary IBAN, the concept, the supplier invoice reference and the currency
   (`EUR` by default).
7. Save.

The payment is created as a **draft** with its reference `PAY-YYYYMMDD-NNNN` and
`payments.payment.created` is emitted. Requires `payments.add_payment`. The panel closes and the
list goes back to its first page, where the new payment sits on top (newest first); the search,
the filters, the sort and the rows per page stay as you left them. If the payment is refused, the
list stays on the page you were on.

If any field fails validation **nothing is written at all** — there is no partial payment.

### Approve a payment

Only a **draft** can be approved. Approving moves it to `approved` and emits
`payments.payment.approved`. Requires `payments.approve_payment`.

### Mark it sent

Only an **approved** payment can be marked sent. This records that it went to the beneficiary or the
bank; **the module sends nothing**. Requires `payments.add_payment`.

### Mark it completed

Only a **sent** payment can be completed. Requires `payments.add_payment`.

### Cancel a payment

1. Choose cancel and give a **reason** — it is required.
2. Confirm.

The payment moves to `cancelled` and the reason is appended to its concept as `[CANCELLED] <reason>`,
so the trail stays with the record. A payment that is already `completed` or `cancelled` **cannot** be
cancelled. Requires `payments.approve_payment`.

## Payment methods

The catalogue of ways you send money (`payments.methods.list`, 50 rows per page). Requires
`payments.view_payment`. Sorted by name.

- **Search** by name or bank account reference.
- **Sort and filter** by name, type, bank account reference or active flag.

### Create a payment method

1. Give it a **name** and a **type** — both required.
2. The type is one of `cash`, `transfer`, `card`, `sepa`, `check` or `other`. Default `transfer`.
3. Optionally add the bank account reference.
4. Save.

Requires `payments.add_payment`.

Deactivating a method stops it being usable for new payments; existing payments keep theirs.
