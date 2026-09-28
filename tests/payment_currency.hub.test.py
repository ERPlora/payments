#!/usr/bin/env python3
"""A payment created without a currency is stored in the HUB's currency, against the REAL kernel (payments#38).

The assistant and an API integration call `payments.payments.create` through the same door as the
Payments screen (`POST /api/command`), but they may leave `currency` out. The runtime fills an
absent property with its schema `default` before the WASM handler runs, and the handler only learns
the hub's currency through the `payments.hub_currency` read the host preloads — so only a real
runtime proves the whole chain: the setting the admin screen writes (`PUT /api/settings`) is the one
the handler reads, for THIS hub, after the runtime has applied the schema.

  1. Hub in yen + no `currency` → the payment reads back in JPY.
  2. Hub in yen + `currency: null` → JPY as well (the key sent empty is not an error).
  3. An explicit currency wins: hub in yen + `currency: "USD"` → USD.
  4. Hub back in euros + no `currency` → EUR — the euro did not move.

It talks to the runtime through the public doors under the runtime's own `hub_id`
(`GET /api/hub/context`, hub#594) and a user minted per run (dev auth trusts `X-User-Id`). The hub
is shared with every battery of the run, so the currency it had is restored at the end whatever
happens.

Usage: `erplora test <dir> --against-hub [dev|stable|sha256:…]` (module-toolkit#110). Never on its
own: without a runtime it FAILS, it does not skip (module-toolkit#50).
"""

import json
import os
import sys
import urllib.error
import urllib.request
import uuid

BASE = (os.environ.get("ERPLORA_HUB_BASE_URL") or "").rstrip("/")
BATTERY = "payment_currency.hub"
USER = f"u-{uuid.uuid4().hex[:8]}"

failures: list[str] = []


def request(hub_id: str, method: str, path: str, body=None):
    """`(status, json body)` of one call to the runtime, whatever it answered."""
    req = urllib.request.Request(
        f"{BASE}{path}",
        data=None if body is None else json.dumps(body).encode(),
        headers={
            "content-type": "application/json",
            "x-hub-id": hub_id,
            "x-user-id": USER,
        },
        method=method,
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            return res.status, json.loads(res.read().decode() or "null")
    except urllib.error.HTTPError as err:
        raw = err.read().decode()
        try:
            return err.code, json.loads(raw or "null")
        except json.JSONDecodeError:
            return err.code, {"raw": raw}


def check(label: str, got, want) -> None:
    if got != want:
        failures.append(f"{label} — expected [{want!r}], got [{got!r}]")
        print(f"  FAIL: {label} — expected [{want!r}], got [{got!r}]")
    else:
        print(f"  ok: {label} = {got!r}")


def new_id(body) -> str | None:
    """The id a command just created, wherever this runtime answers it."""
    for scope in (body or {}, (body or {}).get("data") or {}):
        ids = scope.get("new_ids") if isinstance(scope, dict) else None
        if ids:
            return ids[0]
    return None


def set_currency(hub_id: str, code: str) -> None:
    """The hub's currency through the real admin door — the write the settings screen makes."""
    status, body = request(hub_id, "PUT", "/api/settings", {"currency": code})
    if status != 200 or (body or {}).get("currency") != code:
        raise AssertionError(
            f"PUT /api/settings currency={code} answered {status}: {body}"
        )


def create_method(hub_id: str) -> str:
    status, body = request(
        hub_id,
        "POST",
        "/api/command",
        {
            "name": "payments.methods.create",
            "payload": {
                "name": f"Hub battery {uuid.uuid4().hex[:6]}",
                "method_type": "transfer",
            },
        },
    )
    method_id = new_id(body) if status == 200 else None
    if not method_id:
        raise AssertionError(f"payments.methods.create answered {status}: {body}")
    return method_id


def created_currency(hub_id: str, method_id: str, label: str, extra: dict):
    """Creates a payment with `extra` merged into the payload and reads its currency back; a
    refusal is recorded, not raised, so a red run names every broken case."""
    payload = {
        "payment_method_id": method_id,
        "payment_date": "2026-09-28",
        "amount": 1999,
        "beneficiary_name": "Hub battery supplier",
        **extra,
    }
    status, body = request(
        hub_id,
        "POST",
        "/api/command",
        {"name": "payments.payments.create", "payload": payload},
    )
    payment_id = new_id(body) if status == 200 else None
    if not payment_id:
        check(f"{label}: create answered", (status, body), (200, "a new id"))
        return None
    status, body = request(
        hub_id,
        "POST",
        "/api/query",
        {"name": "payments.payments.get", "params": {"payment_id": payment_id}},
    )
    rows = (body or {}).get("data") if status == 200 else None
    if isinstance(rows, dict):
        rows = rows.get("rows")
    if not rows:
        check(f"{label}: payment read back", (status, body), "one row")
        return None
    return rows[0].get("currency")


def main() -> int:
    if not BASE:
        print(
            f"{BATTERY}: no runtime at the other end (ERPLORA_HUB_BASE_URL is empty)."
        )
        print(
            "Run it with `erplora test <dir> --against-hub`; without a hub this is NOT a skip."
        )
        return 1
    with urllib.request.urlopen(f"{BASE}/api/hub/context", timeout=60) as res:
        hub_id = json.loads(res.read().decode()).get("hub_id")
    if not hub_id:
        print(f"{BATTERY}: GET /api/hub/context did not say the hub_id")
        return 1
    print(
        f"Hub battery · payment currency from the hub (payments#38) · {BASE} · hub {hub_id} · user {USER}"
    )

    status, before = request(hub_id, "GET", "/api/settings")
    if status != 200:
        print(f"GET /api/settings answered {status}: {before}")
        return 1
    original = (before or {}).get("currency") or "EUR"
    try:
        method_id = create_method(hub_id)

        print("\n1 · hub in yen, payload without currency")
        set_currency(hub_id, "JPY")
        check("currency", created_currency(hub_id, method_id, "no currency", {}), "JPY")

        print("\n2 · hub in yen, currency sent as null")
        check(
            "currency",
            created_currency(hub_id, method_id, "null currency", {"currency": None}),
            "JPY",
        )

        print("\n3 · an explicit currency wins over the hub's")
        check(
            "currency",
            created_currency(hub_id, method_id, "explicit USD", {"currency": "USD"}),
            "USD",
        )

        print("\n4 · hub in euros, payload without currency")
        set_currency(hub_id, "EUR")
        check("currency", created_currency(hub_id, method_id, "euro hub", {}), "EUR")
    finally:
        set_currency(hub_id, original)

    print()
    if failures:
        print(f"✗ {BATTERY}: {len(failures)} failure(s):")
        for f in failures:
            print(f"  - {f}")
        return 1
    print(f"✓ {BATTERY}: a payment without a currency is stored in the hub's currency")
    return 0


if __name__ == "__main__":
    sys.exit(main())
