#!/usr/bin/env python3
"""Typing a piece of the reference finds the payment (payments#21).

A payment reference is `PAY-AAAAMMDD-NNNN`. What a person remembers and types is the **last
digits** or **the date** — never the whole string. The REFERENCIA column paints a free-text box,
but `payments.payments.list` filtered it with `op: eq`, so the runtime emitted

    CAST(sub.reference AS TEXT) = CAST(:f_reference AS TEXT)

and typing `0003` emptied the list with nothing on screen to explain it. Same shape as
ERPlora/kitchen#36 / #39 and ERPlora/inventory#74, in one more module.

WHAT IS REPRODUCED of the list engine (`hub/crates/runtime/src/queries.rs`), and only that: the
base SELECT wrapped as a derived table plus the per-column condition the engine emits FOR THE OP
THE MANIFEST DECLARES — `eq` → `CAST(sub.<col> AS TEXT) = CAST(:f_<col> AS TEXT)`, `like` →
`CAST(sub.<col> AS TEXT) LIKE '%' || CAST(:f_<col> AS TEXT) || '%'`. Built FROM the manifest on
purpose: put the op back to `eq` and this test goes red, which is the whole point.

Whether every box MATCHES its column is the job of the sibling contract gate,
`filter_boxes_match_the_manifest.contract.test.py`, which sweeps the whole module without Docker.
This one is the behaviour underneath: that the operator the manifest now declares does what the
user expects, still respects the hub boundary, and did not lose the exact match on the way.

`beneficiary_name` was already `like` and is checked too — not as decoration: it is what proves
this file would catch the regression if somebody narrowed IT to `eq` tomorrow.

Usage: tests/text_filters_narrow_by_fragment.pg.test.py   (exit 0 = green)
  Uses the `erplora-test-pg-5433` container (override: PAYMENTS_TEST_PG_CONTAINER).
"""

import json
import os
import pathlib
import re
import subprocess
import sys
import uuid

MODULE_DIR = pathlib.Path(__file__).resolve().parent.parent
MANIFEST = json.loads((MODULE_DIR / "module.json").read_text(encoding="utf-8"))
CONTAINER = os.environ.get("PAYMENTS_TEST_PG_CONTAINER", "erplora-test-pg-5433")

HUB = "hub-under-test"
OTHER_HUB = "hub-next-door"
NOW = "2026-08-21T10:00:00Z"

#: A full payment reference, in the shape `commands/_insert_payment.sql` writes.
FULL_REFERENCE = "PAY-20260821-0003"

IDENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")

failures: list[str] = []


def fail(msg: str) -> None:
    failures.append(msg)


def literal(value) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, int):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def container_available() -> bool:
    try:
        subprocess.run(
            ["docker", "inspect", CONTAINER], capture_output=True, check=True, text=True
        )
        return True
    except (subprocess.CalledProcessError, FileNotFoundError):
        return False


class ScratchDb:
    """A throwaway database built from this module's own migrations."""

    def __init__(self, prefix: str):
        self.name = f"{prefix}_{os.getpid()}_{uuid.uuid4().hex[:6]}"

    def psql(self, args, db=None, stdin=None) -> str:
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
            "-X",
        ]
        if db:
            cmd += ["-d", db]
        res = subprocess.run(cmd + args, input=stdin, capture_output=True, text=True)
        if res.returncode != 0:
            raise RuntimeError(res.stderr.strip() or res.stdout.strip())
        return res.stdout

    def create(self) -> None:
        self.psql(["-c", f'DROP DATABASE IF EXISTS "{self.name}"'])
        self.psql(["-c", f'CREATE DATABASE "{self.name}"'])
        for rel in MANIFEST["migrations"]["postgres"]:
            self.psql(
                [], db=self.name, stdin=(MODULE_DIR / rel).read_text(encoding="utf-8")
            )

    def drop(self) -> None:
        try:
            self.psql(["-c", f'DROP DATABASE IF EXISTS "{self.name}" WITH (FORCE)'])
        except RuntimeError as exc:
            print(f"  ! could not drop {self.name}: {exc}")

    def rows(self, sql: str) -> list[dict]:
        out = self.psql(
            ["-tAc", f"SELECT COALESCE(json_agg(t), '[]'::json) FROM ({sql}) t"],
            db=self.name,
        )
        return json.loads(out.strip() or "[]")


def column_condition(query: str, column: str, value: str) -> str:
    """The condition the engine emits for this column, given the op THE MANIFEST declares."""
    spec = (MANIFEST["queries"][query].get("list") or {}).get("filters") or {}
    op = (spec.get(column) or {}).get("op")
    if not IDENT.match(column):
        raise RuntimeError(f"{column} is not a plain identifier")
    if op == "eq":
        return f"CAST(sub.{column} AS TEXT) = CAST({literal(value)} AS TEXT)"
    if op == "like":
        return f"CAST(sub.{column} AS TEXT) LIKE '%' || CAST({literal(value)} AS TEXT) || '%'"
    raise RuntimeError(
        f"`{query}` declares no usable filter for `{column}` (op={op!r}) — the box is painted but "
        f"the runtime drops the parameter"
    )


def list_query(
    db: ScratchDb, query: str, column=None, value=None, hub: str = HUB
) -> list[dict]:
    spec = MANIFEST["queries"][query]
    base = (
        (MODULE_DIR / spec["sql"])
        .read_text(encoding="utf-8")
        .rstrip()
        .rstrip(";")
        .replace(":hub_id", literal(hub))
    )
    where = f" WHERE {column_condition(query, column, value)}" if column else ""
    return db.rows(f"SELECT sub.* FROM ({base}) AS sub{where}")


def seed(db: ScratchDb) -> None:
    db.psql(
        [],
        db=db.name,
        stdin=(
            "INSERT INTO payments_payment_method (id, hub_id, name, method_type, created_at) VALUES "
            + ",".join(
                f"({literal(i)},{literal(h)},'Transferencia','transfer',{literal(NOW)})"
                for i, h in (("m1", HUB), ("m2", OTHER_HUB))
            )
            + ";"
        ),
    )
    payments = [
        # id,   reference,             beneficiary,       hub,       method
        ("p1", FULL_REFERENCE, "Proveedor Norte SL", HUB, "m1"),
        ("p2", "PAY-20260821-0004", "Suministros Ana", HUB, "m1"),
        ("p3", "PAY-20250114-0999", "Proveedor Sur SA", HUB, "m1"),
        # The neighbour hub holds the SAME reference on purpose: the boundary has to be what
        # keeps it out, not the value being unique.
        ("p4", FULL_REFERENCE, "Proveedor Norte SL", OTHER_HUB, "m2"),
    ]
    db.psql(
        [],
        db=db.name,
        stdin=(
            "INSERT INTO payments_payment (id, hub_id, reference, payment_method_id, payment_date, "
            "amount, currency, beneficiary_name, concept, status, created_at) VALUES "
            + ",".join(
                "("
                + ",".join(
                    [
                        literal(i),
                        literal(hub),
                        literal(ref),
                        literal(method),
                        "'2026-08-21'",
                        "25000",
                        "'EUR'",
                        literal(name),
                        "'Factura 12'",
                        "'draft'",
                        literal(NOW),
                    ]
                )
                + ")"
                for i, ref, name, hub, method in payments
            )
            + ";"
        ),
    )


def check_column(
    db, query, column, fixtures, full_value, full_expected, nothing_value, neighbour_id
):
    """One free-text column: fragments narrow, the whole value still matches, and the hub holds."""
    # Check the check: without a filter this hub has its three rows and not the neighbour's.
    everything = list_query(db, query)
    if len(everything) != 3:
        fail(
            f"`{query}` unfiltered returned {len(everything)} rows, expected 3 — fixture wrong"
        )
        return

    for label, fragment, expected in fixtures:
        try:
            ids = sorted(str(r["id"]) for r in list_query(db, query, column, fragment))
        except RuntimeError as exc:
            # A column the `list` block does not declare has no condition to emit at all: that is a
            # finding, not a crash, and it has to read like one next to the others.
            fail(f"`{query}`.`{column}` cannot be filtered: {exc}")
            return
        if ids != expected:
            fail(
                f"`{query}`.`{column}` filtered by {label} («{fragment}») returned {ids or 'nothing'}, "
                f"expected {expected} — the column still demands the whole value (payments#21)"
            )

    ids = sorted(str(r["id"]) for r in list_query(db, query, column, full_value))
    if ids != full_expected:
        fail(
            f"`{query}`.`{column}`: the whole value returned {ids or 'nothing'}, expected "
            f"{full_expected} — the exact match regressed"
        )

    if list_query(db, query, column, nothing_value):
        fail(
            f"`{query}`.`{column}`: a fragment matching nothing returned rows — the filter is being ignored"
        )

    if any(
        str(r["id"]) == neighbour_id for r in list_query(db, query, column, full_value)
    ):
        fail(f"`{query}`.`{column}` returned another hub's row — scoping lost")


def check_behaviour(db: ScratchDb) -> None:
    check_column(
        db,
        "payments.payments.list",
        "reference",
        [
            ("the tail of the reference", "0003", ["p1"]),
            ("the day it was issued", "20260821", ["p1", "p2"]),
            ("a plain chunk", "PAY-2025", ["p3"]),
        ],
        FULL_REFERENCE,
        ["p1"],
        "PAY-19990101-0001",
        "p4",
    )
    check_column(
        db,
        "payments.payments.list",
        "beneficiary_name",
        [
            ("a word of the name", "Norte", ["p1"]),
            ("what two suppliers share", "Proveedor", ["p1", "p3"]),
        ],
        "Proveedor Norte SL",
        ["p1"],
        "Ferretería",
        "p4",
    )


def main() -> int:
    if not container_available():
        print(f"SKIPPED: no Postgres in container {CONTAINER} (nothing was verified)")
        return 0

    db = ScratchDb("payments_text_filters")
    db.create()
    try:
        seed(db)
        check_behaviour(db)
    finally:
        db.drop()

    if failures:
        print(f"FAIL ({len(failures)}):")
        for f in failures:
            print(f"  - {f}")
        return 1
    print(
        "OK: reference and beneficiary_name narrow by fragment, the whole value still matches, "
        "and no filter reaches across hubs"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
