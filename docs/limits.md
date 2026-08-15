# Payments — Limits and troubleshooting

## Known limitations you should know about

- **No money is ever moved.** No bank integration, no SEPA file generation, no execution.
- **Invalid transitions are silent no-ops.** The status guard is a `WHERE` clause; a wrong move
  returns success and changes nothing.
- **An unknown or inactive payment method fails silently too.** The payment is simply not created.
- **The IBAN is not validated.**
- **The result of a creation carries no data back.** You get success and an operation count, not the
  new payment's reference — read it from the list.

## Errors you will actually see

These come back with a stable code and **nothing is written**:

| Error | What happened | What to do |
|---|---|---|
| `invalid_payment_method_id` | The method id is not a well-formed identifier | Pick a method from the list |
| `invalid_amount` | The amount is not a decimal greater than zero | Amounts are cents and must be positive |
| `invalid_beneficiary_name` | The name is empty once trimmed | Give a beneficiary |
| `invalid_payment_date` | The date is not `YYYY-MM-DD` or a valid timestamp | Fix the format |

And these fail as **no-ops**, with no error at all:

| Situation | Result |
|---|---|
| The payment method does not exist or is inactive | The payment is not created |
| Approving something that is not `draft` | Nothing changes |
| Marking sent something that is not `approved` | Nothing changes |
| Marking completed something that is not `sent` | Nothing changes |
| Cancelling something already `completed` or `cancelled` | Nothing changes |

## Required fields

| Action | Must provide |
|---|---|
| Create a payment | `payment_method_id`, `payment_date`, `amount`, `beneficiary_name` |
| Cancel a payment | `payment_id`, **`reason`** |
| Create a method | `name`, `method_type` |

## Accepted values

| Field | Values |
|---|---|
| Payment status | `draft`, `approved`, `sent`, `completed`, `cancelled` |
| Method type | `cash`, `transfer`, `card`, `sepa`, `check`, `other` (default `transfer`) |
| Currency | exactly 3 characters, uppercased, default `EUR` |
| Amount | integer cents, greater than zero |

## Caps and sizes

| Limit | Value |
|---|---|
| Rows per page (payments, methods) | 50 |
| Maximum rows a paginated request may ask for | 500 |
| Payments per day per hub, by numbering | 9999 |

Concurrency is safe: simultaneous creations cannot produce a duplicate reference.

## Permissions per action

| To do this | You need |
|---|---|
| See payments and methods | `payments.view_payment` |
| Create a payment, create a method, mark sent, mark completed | `payments.add_payment` |
| **Approve** or **cancel** a payment | `payments.approve_payment` |

By role: **admin** has everything. **manager** has all three. **employee** has **read only** — an
employee cannot create, approve, send or cancel anything.

The split between `add_payment` and `approve_payment` is the separation of duties: registering a
payment and authorising it are different acts.

## Dependencies

**None in either direction.** Payments depends on no module and no module depends on it. It can be
installed and removed freely.

Practical consequences:

- **Nothing in `cash_register` changes when you record a payment.** Paying a supplier in cash here
  does **not** create a cash-out movement in the till; you have to record that separately.
- **Nothing in `invoice` links to it.** The supplier invoice reference is free text.
- Its events are published for anybody who wants them; nothing listens today.

## When something looks wrong

**"I saved a payment and it is not in the list."** Almost always the payment method: if it does not
exist or is inactive, the insert is a silent no-op. Check the method, then create the payment again.

**"I approved it and the status did not change."** It was not `draft`. Re-read the record — an
invalid transition changes nothing and reports nothing.

**"I cannot cancel this payment."** It is already `completed` or `cancelled`. Both are terminal.

**"The reference has today's date but the payment is dated last month."** Correct. The reference uses
the date it was **recorded**, from the server clock, not the payment date.

**"The amount is a hundred times too big or too small."** Amounts are **cents**. `12550` is 125,50 €,
not 12 550 €.

**"The money never left the bank."** Nothing here moves money. "Sent" is a state somebody set by
hand.

**"The supplier invoice reference points at nothing."** It is free text with no validation; there is
no link to follow.

**"Paying a supplier in cash did not show in the till."** Correct — the two modules are unconnected.
Record the cash-out in `cash_register` as well.

**"Two payments got the same reference."** They cannot; the counter is atomic per hub and day, and
this was verified under concurrent creation.
