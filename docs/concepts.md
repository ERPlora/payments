# Payments — Concepts

The things people get wrong on their first day.

## Nothing here moves money

This is the most important thing to understand. **"Sent" means somebody pressed a button**, not that
a transfer left an account. The module generates no SEPA file, calls no bank and executes no payment.

It is a record of what you did elsewhere, with an approval trail. Treat it as a ledger of intent, not
as a payment rail.

## Money out, not money in

A **payment method** here is where **you** pay **from** — your bank account, your card, cash from the
drawer. It is not how a customer pays you; that catalogue lives in `sales`.

The two modules are unrelated and their payment methods are different things with the same name.

## The status ladder only goes one way

`draft` → `approved` → `sent` → `completed`, and any non-terminal state → `cancelled`.

Each transition demands its exact predecessor:

- **approve** requires `draft`;
- **mark sent** requires `approved`;
- **mark completed** requires `sent`;
- **cancel** is refused on `completed` and `cancelled`.

There is no "un-approve" and no way back up the ladder. If you approved by mistake, cancel and create
the correct payment.

## An invalid transition changes nothing — silently

The guard is a `WHERE` clause in the SQL, so an action that does not apply simply matches no rows. You
will not get an explanatory error; you will get success and an unchanged record.

**Always re-read the status after acting on a payment.**

## Cancelling writes the reason into the record

Cancelling requires a reason, and that reason is appended to the payment's concept as
`[CANCELLED] <reason>`. The trail lives with the payment, not in a separate log you have to find.

## Approving and cancelling need a different permission from creating

`payments.approve_payment` governs **approve** and **cancel** — the two authorisation decisions.
`payments.add_payment` governs **create**, **mark sent** and **mark completed** — the operational
steps.

That is the separation of duties: whoever registers a payment is not necessarily who authorises it.
Note the consequence: someone with only `add_payment` can create and then mark things sent and
completed, but can never approve.

## Every amount is an integer number of cents

`12550` is 125,50 €. The amount must be **greater than zero**, and validation is done in exact
integer arithmetic with half-even rounding to two decimals — never in binary floating point, because
money and floats do not mix.

The currency is a three-letter code, uppercased, `EUR` by default.

## The reference's date comes from the server, not from the payment date

The reference is `PAY-YYYYMMDD-NNNN` where the date is **when the payment was recorded**, taken from
the server clock. A payment dated last month, entered today, gets today's date in its reference.

The counter is allocated atomically per hub and day, so simultaneous creations cannot collide.

## An unknown or inactive payment method fails as a no-op

The check that the method exists and is active lives in the SQL, not in validation. If it does not
hold, the insert matches nothing and **the payment is not created** — but you get no explicit error
saying why.

If a payment does not appear after saving, check the method first.

## Validation failures write nothing at all

Malformed method id, amount not greater than zero, empty beneficiary name, unparseable date: each
comes back as a stable error code and **nothing is persisted**. There is no half-created draft to
clean up.

## Dates without a zone are read as UTC

A `YYYY-MM-DD` becomes midnight UTC; a full timestamp with no offset is read as UTC. If your local
day matters, send the offset.

## The supplier invoice reference is free text

It links a payment to a supplier invoice **by convention only** — no foreign key, no validation, no
navigation. Typos in it are typos, not errors.

## Deleting is a soft delete

Payments and methods are marked deleted, never erased.
