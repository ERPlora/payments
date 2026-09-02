#!/usr/bin/env python3
"""No string reaches a screen without its Spanish (payments#24, ADR-0055/0199).

English is the SOURCE language of the code; Spanish is what the merchant actually reads. So a new
string is not «a string» — it is a pair. Half a pair fails in the worst possible way: `erplora.t`
falls back locale → en → the key itself, so a missing `es` does not throw and does not warn. It
just prints the English text, or the raw key, inside an otherwise Spanish screen. Nobody notices
until a customer does.

The three rules, and why each one:

| Rule | Because |
|---|---|
| every `t(CATALOG, '<key>')` in `ui/` resolves in `en.json` AND `es.json` | a key the catalogue does not carry is printed RAW — the user reads `ui.errMethods` |
| the `ui` block has the same keys in both files | this is what catches the string added English-only; the scan above cannot, because the code that uses it is added in the same commit and looks consistent |
| the `es` value is not byte-identical to the `en` one | the other half of the same mistake: the pair exists, and the Spanish side is the English text pasted across |

The third rule has an allowlist for words that are legitimately the same in both languages. It is
EMPTY today, and it stays a list of exceptions with a reason next to each — not a place to park a
string somebody did not want to translate.

Usage: tests/every_string_has_its_translation.contract.test.py   (exit 0 = green)
  No Postgres, no Docker: it reads the catalogues and the Web Components.
"""

import json
import pathlib
import re
import sys

MODULE_DIR = pathlib.Path(__file__).resolve().parent.parent

#: `en` is the source, `es` is what the merchant reads. Both are mandatory (ADR-0055/0199).
LANGS = ("en", "es")

#: Keys whose Spanish IS the English, on purpose. `key: why`. Empty today — keep it that way.
SAME_IN_BOTH: dict[str, str] = {}

#: The prefix the Web Components read through `erplora.t(CATALOG, …)`.
UI_PREFIX = "ui"

#: The floor is the check on the check: if the catalogue reader ever returns nothing — a renamed
#: block, a `locales/` that moved — the sweep would find no keys and pass by knowing nothing.
#: Deliberately BELOW today's count (29): pruning a handful of dead strings is routine and must not
#: turn this red, whereas reading zero of them never is.
UI_STRINGS_FLOOR = 20

failures: list[str] = []


def fail(msg: str) -> None:
    failures.append(msg)


def catalog(lang: str) -> dict:
    return json.loads(
        (MODULE_DIR / "locales" / f"{lang}.json").read_text(encoding="utf-8")
    )


def resolve(data: dict, key: str):
    """`ui.errMethods` → the leaf, or `None` if any hop is missing."""
    node = data
    for hop in key.split("."):
        if not isinstance(node, dict) or hop not in node:
            return None
        node = node[hop]
    return node


#: `/* … */`, and `// …` when the slashes are not the ones in `https://`.
BLOCK_COMMENT = re.compile(r"/\*.*?\*/", re.S)
LINE_COMMENT = re.compile(r"(?<!:)//[^\n]*")


def strip_comments(src: str) -> str:
    """Prose out, code in.

    Not decoration: the component EXPLAINS itself with `erplora.t(CATALOG, 'ui.clave')` as an
    example, and a scanner that reads comments reports `ui.clave` as a missing translation. A gate
    with a false positive is a gate somebody switches off, so it reads the code and only the code.
    The `(?<!:)` keeps a `https://…` inside a string from truncating a real call on the same line.
    """
    return LINE_COMMENT.sub("", BLOCK_COMMENT.sub("", src))


#: The two shapes a component reads a string with. The SECOND one is the one that matters and the
#: one a first pass of this gate missed: every screen defines `const t = (k) => erplora().t(CATALOG,
#: k)` and then calls `t('ui.colReference')`, so scanning only for the `CATALOG` form found five
#: keys out of twenty-nine and would have called that green.
DIRECT_CALL = re.compile(r"\bt\(\s*CATALOG\s*,\s*'([^']+)'")
ALIAS_CALL = re.compile(r"\bt\(\s*'([^']+)'\s*[,)]")


def used_keys(namespaces: set[str]) -> dict[str, list[str]]:
    """`key -> the files that read it`, discovered from the components — never listed here.

    The alias form is only credited when the key's first segment is a real top-level block of the
    catalogue (`ui`, `navigation`, …). That is what keeps some other one-letter `t(…)` from being
    read as a translation call, while still catching the case worth catching: a typo inside a
    namespace that does exist.
    """
    found: dict[str, list[str]] = {}
    for path in sorted((MODULE_DIR / "ui").rglob("*.ts")):
        if path.name.endswith(".test.ts"):
            continue
        src = strip_comments(path.read_text(encoding="utf-8"))
        keys = set(DIRECT_CALL.findall(src))
        keys |= {k for k in ALIAS_CALL.findall(src) if k.split(".")[0] in namespaces}
        for key in keys:
            found.setdefault(key, []).append(str(path.relative_to(MODULE_DIR)))
    return found


def main() -> int:
    catalogs = {}
    for lang in LANGS:
        path = MODULE_DIR / "locales" / f"{lang}.json"
        if not path.exists():
            print(
                f"FAIL: locales/{lang}.json is missing — the module ships half a catalogue"
            )
            return 1
        catalogs[lang] = catalog(lang)

    ui = {lang: (catalogs[lang].get(UI_PREFIX) or {}) for lang in LANGS}

    if len(ui["en"]) < UI_STRINGS_FLOOR:
        print(
            f"FAIL: only {len(ui['en'])} string(s) read from locales/en.json; this module has at "
            f"least {UI_STRINGS_FLOOR}. The catalogue reader is broken, and a broken sweep passes."
        )
        return 1

    # 1 · every key the code reads exists in both catalogues.
    namespaces = {k for k, v in catalogs["en"].items() if isinstance(v, dict)}
    read = used_keys(namespaces)
    if len(read) < UI_STRINGS_FLOOR:
        print(
            f"FAIL: only {len(read)} translated string(s) discovered in `ui/`; this module reads at "
            f"least {UI_STRINGS_FLOOR}. The call scanner is broken, and a broken sweep passes."
        )
        return 1
    for key, files in sorted(read.items()):
        for lang in LANGS:
            if resolve(catalogs[lang], key) is None:
                fail(
                    f"{', '.join(sorted(set(files)))} reads `{key}`, which locales/{lang}.json does "
                    f"not carry: `erplora.t` prints the key itself on screen"
                )

    # 2 · the `ui` block says the same things in both languages.
    for key in sorted(set(ui["en"]) - set(ui["es"])):
        fail(
            f"`{UI_PREFIX}.{key}` exists in locales/en.json but not in locales/es.json: a Spanish "
            f"hub reads the English text with nothing to warn anybody"
        )
    for key in sorted(set(ui["es"]) - set(ui["en"])):
        fail(
            f"`{UI_PREFIX}.{key}` exists in locales/es.json but not in locales/en.json: English is "
            f"the SOURCE (ADR-0055), so a string with no source is a dead key or a missing original"
        )

    # 3 · the Spanish is not the English pasted across.
    for key in sorted(set(ui["en"]) & set(ui["es"])):
        if key in SAME_IN_BOTH:
            continue
        if isinstance(ui["en"][key], str) and ui["en"][key] == ui["es"][key]:
            fail(
                f"`{UI_PREFIX}.{key}` is the same string in both catalogues ({ui['en'][key]!r}): it "
                f"is untranslated. If it is genuinely identical in Spanish, declare it in "
                f"SAME_IN_BOTH with the reason"
            )

    if failures:
        print(f"FAIL ({len(failures)}):")
        for f in failures:
            print(f"  - {f}")
        return 1

    print(
        f"OK: the {len(ui['en'])} strings of this module carry their `es`, and every key the "
        f"components read resolves in both catalogues"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
