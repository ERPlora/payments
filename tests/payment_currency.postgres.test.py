#!/usr/bin/env python3
"""A payment created without a currency takes the HUB's currency, read from the hub's own settings (payments#38).

`payments.payments.create` runs a WASM handler, and the assistant or an API integration may leave
`currency` out. Until #38 two things turned that payment into euros: the schema declared
`"default": "EUR"` (the runtime fills an absent property with its default before the handler runs)
and the handler fell back to `"EUR"` itself. The handler runs in a sandbox and cannot read the
database, so the hub currency reaches it the way cash_register#111 does it (ADR-0069): a query the
host preloads into `context.reads`, never a value the client sends.

What this file pins, against a REAL Postgres:

  1. The manifest wires it: `payments.payments.create` declares `payments.hub_currency` as a
     REQUIRED read — without it the handler silently falls back to euros.
  2. The schema no longer invents a currency: `currency` accepts `null` and its default is `null`.
  3. A hub that never set its currency still gets exactly ONE row (`currency` empty): the handler
     reads «no currency» as the runtime does — the hub is in euros.
  4. TENANCY: each hub reads ITS OWN currency — hub B's dinars never reach hub A's payment.

Usage: tests/payment_currency.postgres.test.py   (exit 0 = green)
  Uses the `erplora-test-pg-5433` container (override: PAYMENTS_TEST_PG_CONTAINER) and drops its
  scratch database at the end, pass or fail.
"""

import json
import os
import pathlib
import re
import subprocess
import sys

MODULE_DIR = pathlib.Path(__file__).resolve().parent.parent
MANIFEST = json.loads((MODULE_DIR / "module.json").read_text())

CONTAINER = os.environ.get("PAYMENTS_TEST_PG_CONTAINER", "erplora-test-pg-5433")
DB = f"payments_currency_test_{os.getpid()}"
HUB = "hub-a"
OTHER_HUB = "hub-b"
QUERY = "payments.hub_currency"
COMMAND = "payments.payments.create"

failures: list[str] = []


def fail(message: str) -> None:
    failures.append(message)
    print(f"  FAIL: {message}")


def ok(label: str) -> None:
    print(f"  ok: {label}")


def psql(args: list[str], db: str | None = None, stdin: str | None = None) -> str:
    cmd = [
        "docker",
        "exec",
        "-i",
        CONTAINER,
        "psql",
        "-v",
        "ON_ERROR_STOP=1",
        "-U",
        "postgres",
    ]
    if db:
        cmd += ["-d", db]
    res = subprocess.run(cmd + args, input=stdin, capture_output=True, text=True)
    if res.returncode != 0:
        raise RuntimeError(res.stderr.strip() or res.stdout.strip())
    return res.stdout


def literal(value) -> str:
    if value is None:
        return "NULL"
    return "'" + str(value).replace("'", "''") + "'"


def bind(sql: str, params: dict) -> str:
    return re.sub(
        r"(?<!:):([a-z_][a-z0-9_]*)",
        lambda m: literal(params.get(m.group(1))),
        sql,
        flags=re.IGNORECASE,
    )


def run_query(hub: str) -> list[dict]:
    sql = bind(
        (MODULE_DIR / MANIFEST["queries"][QUERY]["sql"]).read_text(), {"hub_id": hub}
    )
    sql = sql.rstrip().rstrip(";")
    out = psql(
        [
            "-tA",
            "-c",
            f"SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) FROM ({sql}) t",
        ],
        db=DB,
    )
    return json.loads(out.strip() or "[]")


def set_hub_setting(key: str, value: str, hub: str) -> None:
    psql(
        [
            "-c",
            f"INSERT INTO hub_settings (hub_id, key, value) VALUES ({literal(hub)}, {literal(key)}, {literal(value)})",
        ],
        db=DB,
    )


def check_manifest() -> bool:
    if QUERY not in MANIFEST.get("queries", {}):
        fail(f"the manifest does not declare the query `{QUERY}`")
        return False
    reads = MANIFEST["commands"][COMMAND].get("reads", [])
    declared = [r for r in reads if isinstance(r, dict) and r.get("query") == QUERY]
    if not declared or not declared[0].get("required"):
        fail(f"`{COMMAND}` must declare `{QUERY}` as a REQUIRED read, got {reads!r}")
    else:
        ok(f"`{COMMAND}` preloads `{QUERY}` (required)")
    return True


def check_schema() -> None:
    schema = json.loads(
        (MODULE_DIR / MANIFEST["commands"][COMMAND]["schema"]).read_text()
    )
    currency = schema["properties"]["currency"]
    types = currency.get("type")
    types = types if isinstance(types, list) else [types]
    if "null" not in types:
        fail(f"`currency` must accept null (sent empty = absent), got type {types!r}")
    else:
        ok("`currency` accepts null")
    if currency.get("default", None) is not None:
        fail(
            f"`currency` must not default to a fixed code — the runtime would fill it before the "
            f"handler sees the hub's currency; got default {currency.get('default')!r}"
        )
    else:
        ok("`currency` has no fixed default")


def check_against_postgres() -> None:
    if (
        subprocess.run(["docker", "inspect", CONTAINER], capture_output=True).returncode
        != 0
    ):
        fail(
            f"container `{CONTAINER}` is not running — this can only be proven against Postgres"
        )
        return

    psql(["-c", f'CREATE DATABASE "{DB}"'])
    try:
        for rel in MANIFEST["migrations"]["postgres"]:
            psql([], db=DB, stdin=(MODULE_DIR / rel).read_text())
        # The core's settings table (hub/crates/runtime/src/settings.rs) — the hub creates it.
        psql(
            [
                "-c",
                "CREATE TABLE hub_settings (hub_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL DEFAULT '', "
                "updated_at TEXT, updated_by TEXT, PRIMARY KEY (hub_id, key))",
            ],
            db=DB,
        )
        # A real hub keeps many settings: without them a query that forgot `h.key = 'currency'`
        # still reads one row here and passes (rv-35 on cart_checkout#35).
        for hub, country, tz in (
            (HUB, "JP", "Asia/Tokyo"),
            (OTHER_HUB, "KW", "Asia/Kuwait"),
        ):
            set_hub_setting("country_code", country, hub)
            set_hub_setting("timezone", tz, hub)

        rows = run_query(HUB)
        if rows != [{"currency": None}]:
            fail(
                f"a hub with no currency setting must read ONE empty row, got {rows!r}"
            )
        else:
            ok("no currency setting → one row, empty (the handler reads euros)")

        set_hub_setting("currency", "JPY", HUB)
        set_hub_setting("currency", "KWD", OTHER_HUB)

        a, b = run_query(HUB), run_query(OTHER_HUB)
        if a != [{"currency": "JPY"}]:
            fail(f"hub A must read its own yen, got {a!r}")
        else:
            ok("hub A reads JPY")
        if b != [{"currency": "KWD"}]:
            fail(f"hub B must read its own dinars, got {b!r}")
        else:
            ok("hub B reads KWD")
    finally:
        psql(["-c", f'DROP DATABASE IF EXISTS "{DB}" WITH (FORCE)'])


def main() -> int:
    print("[currency of a new payment] real Postgres")
    check_schema()
    if check_manifest():
        check_against_postgres()
    if failures:
        print(f"\n{len(failures)} failure(s)")
        return 1
    print("\nOK — a payment without a currency reads the hub's own, tenant by tenant")
    return 0


if __name__ == "__main__":
    sys.exit(main())
