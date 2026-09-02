#!/usr/bin/env python3
"""Every filter box of this module has to mean what it looks like (payments#21, ERPlora/hub#1182).

A column header carries a promise: a free-text box says «type a piece of it», a dropdown says
«choose one of these». The manifest is what actually happens — `op: "like"` narrows by fragment,
`op: "eq"` demands the whole value, and a column the `list` block never declares is a box that does
**nothing at all**. When the two disagree the user gets no error: the list simply empties, or the
typing is ignored, and there is nothing on screen to explain it.

WHY IT IS HERE AND NOT ONLY IN THE MODULE THAT BROKE. `hub#1182` swept the 27 module repos looking
for exactly this shape and found it in five. It has been fixed one column at a time in
`kitchen` (#36, #39) and `inventory` (#74) — and it came back HERE anyway, on `reference`, because
a fix in another repo guards nothing in this one. So this gate is a PORT, not a copy of a finding:
it reads EVERY table of this module, discovers the screen→query pairs from the source instead of
listing them, and stays. A new table is covered the day it is written, without anybody remembering.

## The rules, and why each one

| The box says | The manifest must say | Because |
|---|---|---|
| `filterType: 'text'` | `op: 'like'` | a free-text box invites a fragment; `eq` empties the list unless the user types the value whole |
| `filterType: 'select'` | `op: 'eq'` | a closed domain is CHOSEN, and the value chosen is exact — `like` would silently match one value inside another |
| `filterType: 'range'` / `'daterange'` | `op: 'range'` | two bounds need the operator that takes two bounds |
| `filterable: true` | the column IS in `list.filters` | otherwise the runtime drops the `f_<col>` parameter and the box does nothing (hub#1182) |
| `sortable: true` | the column IS in `list.sort` | the sort whitelist is a SECOND door: a header outside it does not sort, silently |

REMAPS. A screen may legitimately paint a box on one key and send another — `inventory` paints its
three-state «status» column on `is_active` and routes the third value to `needs_tax_setup`. This
module has none today, and that is why `REMAPPED` is empty rather than absent: the day one appears
it is DECLARED, with the columns it feeds, and the declaration is checked too — a remap pointing at
a filter the query does not declare is the same empty promise with one more step.

Usage: tests/filter_boxes_match_the_manifest.contract.test.py   (exit 0 = green)
  No Postgres, no Docker: it reads the manifest and the Web Components.
"""

import json
import pathlib
import re
import sys

MODULE_DIR = pathlib.Path(__file__).resolve().parent.parent
MANIFEST = json.loads((MODULE_DIR / "module.json").read_text(encoding="utf-8"))

#: What the manifest has to declare for each kind of box the table paints.
EXPECTED_OP = {
    "text": "like",
    "select": "eq",
    "range": "range",
    "daterange": "range",
}

#: Why each one, in the words the failure message uses.
WHY = {
    "text": "a free-text box invites a FRAGMENT; with `eq` anything short of the whole value empties the list",
    "select": "a closed domain is CHOSEN, so the match is exact; `like` would match the value inside another one",
    "range": "two bounds need the operator that takes two bounds",
    "daterange": "two bounds need the operator that takes two bounds",
}

#: `(query, painted column) -> the filters the screen really writes`. See REMAPS above.
#: Empty on purpose: this module paints every box on its own key today.
REMAPPED: dict[tuple[str, str], tuple[str, ...]] = {}

#: How many list screens this module has today. The floor is the check on the check: if the
#: discovery stops finding them, a broken sweep would pass by knowing nothing.
SCREENS_TODAY = 1

failures: list[str] = []


def fail(msg: str) -> None:
    failures.append(msg)


def components():
    """Every Web Component of the module that drives a paginated `list` query, and its query.

    Discovered, never listed: `createListController(erplora(), '<query>', …)` is the one way a
    screen binds itself to a list, so a new table cannot be born outside this gate.
    """
    found = []
    for path in sorted((MODULE_DIR / "ui/components").rglob("*.ts")):
        if path.name.endswith(".test.ts"):
            continue
        src = path.read_text(encoding="utf-8")
        for query in re.findall(
            r"createListController[^(]*\(\s*erplora\(\)\s*,\s*'([^']+)'", src
        ):
            found.append((path, query, src))
    return found


def declared_columns(src: str):
    """`(column, filterType|None, filterable, sortable)` for every column the component paints."""
    out = []
    for chunk in src.split("key: '")[1:]:
        column = chunk.split("'")[0]
        kind = re.search(r"filterType: '(\w+)'", chunk)
        out.append(
            (
                column,
                kind.group(1) if kind else None,
                "filterable: true" in chunk,
                "sortable: true" in chunk,
            )
        )
    return out


def check(path, query, src) -> None:
    screen = path.relative_to(MODULE_DIR)
    spec = MANIFEST["queries"].get(query)
    if spec is None:
        fail(f"{screen} drives `{query}`, which the manifest does not declare")
        return
    block = spec.get("list") or {}
    if not block:
        fail(f"`{query}` has no `list` block, but {screen} paginates it")
        return
    filters = block.get("filters") or {}
    sortable_whitelist = set(block.get("sort") or [])

    for column, kind, filterable, sortable in declared_columns(src):
        remap = REMAPPED.get((query, column))
        if remap:
            # The box does not feed its own key: check the columns it really writes instead.
            for target in remap:
                if target not in filters:
                    fail(
                        f"{screen} routes the `{column}` box to `{target}`, which `{query}` does not "
                        f"declare as a filter: the runtime drops `f_{target}` and that choice does nothing"
                    )
        elif filterable and column not in filters:
            fail(
                f"{screen} paints a filter box on `{column}` but `{query}` declares no filter for it: "
                f"the runtime drops the parameter and the box does nothing (hub#1182)"
            )
        elif kind:
            op = (filters.get(column) or {}).get("op")
            expected = EXPECTED_OP.get(kind)
            if expected is None:
                fail(
                    f"{screen} paints `{column}` as `filterType: '{kind}'`, which this gate does not know — teach it"
                )
            elif op != expected:
                fail(
                    f"{screen} paints `{column}` as `filterType: '{kind}'` but `{query}` filters it with "
                    f"`op: {op!r}` (expected `{expected}`) — {WHY[kind]}"
                )
        if sortable and column not in sortable_whitelist:
            fail(
                f"{screen} paints `{column}` as sortable but `{query}` does not whitelist it in `list.sort`: "
                f"clicking that header does nothing"
            )


def main() -> int:
    pairs = components()
    if len(pairs) < SCREENS_TODAY:
        print(
            f"FAIL: only {len(pairs)} list screen(s) discovered; this module has at least "
            f"{SCREENS_TODAY} (the payments table). The discovery is broken, and a broken sweep "
            "passes."
        )
        return 1

    for path, query, src in pairs:
        check(path, query, src)

    if failures:
        print(f"FAIL ({len(failures)}):")
        for f in failures:
            print(f"  - {f}")
        return 1

    covered = ", ".join(sorted({q for _, q, _ in pairs}))
    print(
        f"OK: every filter box and every sortable header of {len(pairs)} screen(s) matches what "
        f"the manifest concedes ({covered})"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
