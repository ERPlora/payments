//! Handler WASM (Tier 2) del módulo `payments` — alta de pago saliente.
//! Portado de old_modules/m_payments (`PaymentService.create_payment` +
//! `generate_payment_reference`). Lógica pura, sin BD: recibe `{payload, context}`,
//! valida/normaliza y devuelve **intenciones** (commands `_`-prefijados del propio
//! módulo) que el host valida y ejecuta en UNA transacción, más el evento
//! `payments.payment.created`.
//!
//! Runtime constraints (patterns `kitchen`/`tasks`, ADR-0020; the only preloaded read is the
//! hub currency, ADR-0069):
//! * currency: payload → the hub's own (`context.reads["payments.hub_currency"]`, a REQUIRED
//!   read) → EUR; never a fixed default (payments#38);
//! * la existencia/actividad del método de pago se guarda EN EL SQL de la intención
//!   (`_insert_payment` es `INSERT … SELECT … WHERE EXISTS(método vivo y activo)`:
//!   no-op si no se cumple — equivalente a `payment_method_not_found` /
//!   `payment_method_inactive`); aquí solo se valida el FORMATO UUID;
//! * ids: el host pasa `context.new_ids` (autoridad de ids); el guest solo los reparte;
//! * referencia atómica `PAY-YYYYMMDD-NNNN`: `_bump_counter` (upsert) +
//!   `_insert_payment` leyendo el contador con subquery en la misma transacción
//!   (patrón `sales`/`kitchen`/`tasks`; el guest nunca hace read-back). `day` se
//!   deriva de `context.now` (reloj del host), NO de `payment_date`.
//! * importes: aritmética decimal exacta en céntimos (i64) con redondeo half-even
//!   a 2 decimales (equivalente a `Decimal.quantize(0.01)`); nunca float binario
//!   en la validación/redondeo.

use erplora_guest_sdk::money;
use erplora_guest_sdk::{Event, Operation, Output};
use serde_json::{json, Map, Value};

#[cfg(feature = "guest")]
use extism_pdk::*;

// ── Exports WASM ───────────────────────────────────────────────────────────

#[cfg(feature = "guest")]
#[plugin_fn]
pub fn create_payment(input: Json<erplora_guest_sdk::Input>) -> FnResult<Json<Output>> {
    to_fn_result(create_payment_pure(input.into_inner().into_value()))
}

#[cfg(feature = "guest")]
fn to_fn_result(r: Result<Output, String>) -> FnResult<Json<Output>> {
    match r {
        Ok(out) => Ok(Json(out)),
        Err(e) => Err(Error::msg(e).into()),
    }
}

// ── Helpers (mismo estilo que sales/kitchen/tasks-handler) ─────────────────

fn as_str(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        _ => String::new(),
    }
}

fn str_or(p: &Value, k: &str, d: &str) -> String {
    non_blank_or(&as_str(p.get(k).unwrap_or(&Value::Null)), d)
}

fn non_blank_or(s: &str, d: &str) -> String {
    let s = s.trim();
    if s.is_empty() { d.to_string() } else { s.to_string() }
}

fn day_from_now(now: &str) -> String {
    let date = now.split('T').next().unwrap_or("");
    let digits: String = date.chars().filter(|c| c.is_ascii_digit()).collect();
    if digits.len() >= 8 { digits[..8].to_string() } else { "00000000".to_string() }
}

struct Ctx {
    now: String,
    new_ids: Vec<String>,
    /// The hub currency from the trusted `payments.hub_currency` read the host preloads
    /// (payments#38, ADR-0069); empty when the hub never set it or the read is absent.
    hub_currency: String,
}

fn split_input(input: &Value) -> (Value, Ctx) {
    let payload = input.get("payload").cloned().unwrap_or(Value::Null);
    let context = input.get("context").cloned().unwrap_or(Value::Null);
    let empty: Vec<Value> = Vec::new();
    let new_ids = context
        .get("new_ids")
        .and_then(|v| v.as_array())
        .unwrap_or(&empty)
        .iter()
        .map(as_str)
        .collect();
    let hub_currency = context
        .get("reads")
        .and_then(|r| r.get("payments.hub_currency"))
        .and_then(|rows| rows.as_array())
        .and_then(|rows| rows.first())
        .and_then(|row| row.get("currency"))
        .map(as_str)
        .unwrap_or_default();
    let ctx = Ctx {
        now: context.get("now").map(as_str).unwrap_or_default(),
        new_ids,
        hub_currency,
    };
    (payload, ctx)
}

// ── Validación de UUID (formato 8-4-4-4-12 hex) ────────────────────────────

fn is_uuid(s: &str) -> bool {
    let groups: Vec<&str> = s.split('-').collect();
    if groups.len() != 5 {
        return false;
    }
    let lens = [8usize, 4, 4, 4, 12];
    groups
        .iter()
        .zip(lens.iter())
        .all(|(g, l)| g.len() == *l && g.chars().all(|c| c.is_ascii_hexdigit()))
}

// ── Importe: decimal exacto en céntimos (sin float binario) ────────────────

/// Parsea un importe **en céntimos** (`i64`) del payload (ADR-0123: la UI envía céntimos
/// enteros). Delegado ÍNTEGRO en `money::from_json` del SDK: entero o string de entero, y si
/// se cuela un decimal lo redondea HALF_UP — el único modo del hub (§4). El half-even local
/// con epsilon `1e-9` que vivía aquí era el último redondeo divergente de payments.
/// Devuelve `None` si no es numérico válido o es negativo (`amount > 0` es regla de negocio).
fn parse_amount_cents(v: &Value) -> Option<i64> {
    let cents = money::from_json(v, i64::MIN);
    if cents == i64::MIN || cents < 0 {
        return None;
    }
    Some(cents)
}

/// Céntimos → string decimal exacto `"NNN.NN"` (para el bind SQL y el evento).
fn cents_to_decimal(cents: i64) -> String {
    format!("{}.{:02}", cents / 100, cents % 100)
}

// ── Fecha: normalización ISO-8601 → UTC ────────────────────────────────────
// (algoritmo de Howard Hinnant, mismo helper que tasks-handler)

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = (if y >= 0 { y } else { y - 399 }) / 400;
    let yoe = y - era * 400;
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719468;
    let era = (if z >= 0 { z } else { z - 146096 }) / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn is_leap(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

fn days_in_month(y: i64, m: i64) -> i64 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => if is_leap(y) { 29 } else { 28 },
        _ => 0,
    }
}

fn parse_int(s: &str) -> Option<i64> {
    if s.is_empty() || !s.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    s.parse::<i64>().ok()
}

/// Parsea `YYYY-MM-DD` validando rangos del calendario.
fn parse_date(s: &str) -> Option<(i64, i64, i64)> {
    let parts: Vec<&str> = s.split('-').collect();
    if parts.len() != 3 || parts[0].len() != 4 || parts[1].len() != 2 || parts[2].len() != 2 {
        return None;
    }
    let (y, m, d) = (parse_int(parts[0])?, parse_int(parts[1])?, parse_int(parts[2])?);
    if !(1..=12).contains(&m) || d < 1 || d > days_in_month(y, m) {
        return None;
    }
    Some((y, m, d))
}

/// Parsea `HH:MM[:SS[.ffff]]` → segundos del día.
fn parse_time(s: &str) -> Option<i64> {
    let s = s.split('.').next().unwrap_or(s);
    let parts: Vec<&str> = s.split(':').collect();
    if parts.len() < 2 || parts.len() > 3 {
        return None;
    }
    let h = parse_int(parts[0])?;
    let mi = parse_int(parts[1])?;
    let se = if parts.len() == 3 { parse_int(parts[2])? } else { 0 };
    if h > 23 || mi > 59 || se > 59 {
        return None;
    }
    Some(h * 3600 + mi * 60 + se)
}

/// Parsea el sufijo de offset (`Z` | `±HH:MM` | `±HHMM` | `±HH`) → (resto, minutos).
fn split_offset(t: &str) -> Option<(&str, i64)> {
    if let Some(rest) = t.strip_suffix('Z').or_else(|| t.strip_suffix('z')) {
        return Some((rest, 0));
    }
    if let Some(idx) = t.rfind(['+', '-']) {
        if idx > 0 {
            let (rest, off) = t.split_at(idx);
            let sign = if off.starts_with('-') { -1 } else { 1 };
            let off = &off[1..];
            let (h, m) = match off.len() {
                5 if off.as_bytes()[2] == b':' => (parse_int(&off[..2])?, parse_int(&off[3..])?),
                4 => (parse_int(&off[..2])?, parse_int(&off[2..])?),
                2 => (parse_int(off)?, 0),
                _ => return None,
            };
            if h > 23 || m > 59 {
                return None;
            }
            return Some((rest, sign * (h * 60 + m)));
        }
    }
    Some((t, 0)) // naive → se asume UTC (WASM-TODO: "si viene sin zona, asumir UTC")
}

/// Normaliza `payment_date` a ISO UTC `YYYY-MM-DDTHH:MM:SS+00:00`.
/// Acepta `YYYY-MM-DD` (→ `T00:00:00+00:00`) o timestamp ISO completo con offset
/// `Z`/`±HH:MM` (→ convertido a UTC) o naive (→ se asume UTC).
fn normalize_payment_date(s: &str) -> Option<String> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    let (date_part, time_part) = match s.find(['T', ' ']) {
        Some(i) => (&s[..i], &s[i + 1..]),
        None => (s, ""),
    };
    let (y, m, d) = parse_date(date_part)?;
    if time_part.is_empty() {
        return Some(format!("{y:04}-{m:02}-{d:02}T00:00:00+00:00"));
    }
    let (clock, off_min) = split_offset(time_part)?;
    let secs = parse_time(clock)?;

    let mut total = secs - off_min * 60;
    let mut days = days_from_civil(y, m, d);
    while total < 0 {
        total += 86_400;
        days -= 1;
    }
    while total >= 86_400 {
        total -= 86_400;
        days += 1;
    }
    let (yy, mm, dd) = civil_from_days(days);
    let (hh, rem) = (total / 3600, total % 3600);
    let (mi, ss) = (rem / 60, rem % 60);
    Some(format!("{yy:04}-{mm:02}-{dd:02}T{hh:02}:{mi:02}:{ss:02}+00:00"))
}

// ── create_payment (command payments.payments.create) ──────────────────────

/// Lógica pura: `{payload, context}` → intenciones
/// `_bump_counter{day}` → `_insert_payment{…}` + evento `payments.payment.created`.
pub fn create_payment_pure(input: Value) -> Result<Output, String> {
    let (payload, ctx) = split_input(&input);

    // payment_method_id: required, UUID format. Existence + is_active are guarded
    // in the `_insert_payment` SQL (no preloaded read for the method).
    let method_id = as_str(payload.get("payment_method_id").unwrap_or(&Value::Null))
        .trim()
        .to_lowercase();
    if !is_uuid(&method_id) {
        return Err(format!("invalid_payment_method_id: {method_id}"));
    }

    // amount: decimal exacto, > 0 (la regla de negocio que justifica el WASM).
    let raw_amount = payload.get("amount").unwrap_or(&Value::Null);
    let cents = parse_amount_cents(raw_amount)
        .ok_or_else(|| format!("invalid_amount: {}", as_str(raw_amount)))?;
    if cents <= 0 {
        return Err(format!("invalid_amount: {}", cents_to_decimal(cents)));
    }

    // beneficiary_name: requerido, no vacío tras trim (se persiste recortado).
    let beneficiary_name =
        as_str(payload.get("beneficiary_name").unwrap_or(&Value::Null)).trim().to_string();
    if beneficiary_name.is_empty() {
        return Err("invalid_beneficiary_name".to_string());
    }

    // payment_date: ISO YYYY-MM-DD o timestamp completo (sin zona ⇒ UTC).
    let raw_date = as_str(payload.get("payment_date").unwrap_or(&Value::Null));
    let payment_date = normalize_payment_date(&raw_date)
        .ok_or_else(|| format!("invalid_payment_date: {raw_date}"))?;

    // Defaults.
    // payments#38: the caller's code, else THIS hub's currency (the setting the settings screen
    // writes, preloaded by the host), else EUR — the runtime's own fallback for a hub that never
    // set it. A fixed "EUR" turned a yen hub's payment into euros whenever the assistant or an
    // API integration left `currency` out (null or blank counts as absent).
    let currency =
        str_or(&payload, "currency", &non_blank_or(&ctx.hub_currency, "EUR")).to_uppercase();
    let beneficiary_iban = str_or(&payload, "beneficiary_iban", "");
    let concept = str_or(&payload, "concept", "");
    let supplier_invoice_ref = str_or(&payload, "supplier_invoice_ref", "");

    // Id del pago: el host es la autoridad de ids; el guest reparte new_ids.
    let payment_id = ctx.new_ids.first().cloned().ok_or("missing_new_ids")?;
    // day para PAY-YYYYMMDD-NNNN: del reloj del host (context.now), no de payment_date.
    let day = day_from_now(&ctx.now);

    let mut bump = Map::new();
    bump.insert("day".into(), json!(day));

    let mut p = Map::new();
    p.insert("payment_id".into(), json!(payment_id));
    p.insert("day".into(), json!(day));
    p.insert("payment_method_id".into(), json!(method_id));
    p.insert("payment_date".into(), json!(payment_date));
    // Bind en céntimos enteros (ADR-0007): columna INTEGER en ambos motores
    // (shim → BIGINT en Postgres). El redondeo ya se hizo en céntimos i64.
    p.insert("amount".into(), json!(cents));
    p.insert("currency".into(), json!(currency));
    p.insert("beneficiary_name".into(), json!(beneficiary_name));
    p.insert("beneficiary_iban".into(), json!(beneficiary_iban));
    p.insert("concept".into(), json!(concept));
    p.insert("supplier_invoice_ref".into(), json!(supplier_invoice_ref));

    let event = Event::new("payments.payment.created", json!({
        "sender": "payments",
        "payment_id": payment_id,
        "payment_method_id": method_id,
        "amount": cents, // céntimos (contrato inter-módulo, ADR-0007)
        "currency": currency,
        "beneficiary_name": beneficiary_name,
        "payment_date": payment_date,
        "status": "draft",
        "day": day,
    }));

    // `..Default::default()` so the literal compiles against BOTH shapes of `Output`: the one
    // before hub#139 and the one that gained `error` (structured domain rejection). Without it the
    // handler stops compiling the moment the hub checkout moves forward, and with it nobody can
    // rebuild `dist/handler.wasm`.
    Ok(Output {
        operations: vec![
            Operation::sql("payments._bump_counter", bump),
            Operation::sql("payments._insert_payment", p),
        ],
        events: vec![event],
        ..Default::default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(amount: Value) -> Value {
        json!({
            "payload": {
                "payment_method_id": "11111111-1111-1111-1111-111111111111",
                "amount": amount,
                "beneficiary_name": "Proveedor SL",
                "payment_date": "2026-05-31"
            },
            "context": { "now": "2026-05-31T10:00:00+00:00", "new_ids": ["aaaaaaaa-0000-0000-0000-000000000000"] }
        })
    }

    #[test]
    fn amount_is_bound_and_emitted_in_cents() {
        // 1234 céntimos = 12.34€. Bind y evento van en céntimos enteros.
        let out = create_payment_pure(input(json!(1234))).unwrap();
        let ins = out.operations.iter().find(|o| o.command == "payments._insert_payment").unwrap();
        assert_eq!(ins.params["amount"], json!(1234));
        assert_eq!(out.events[0].payload["amount"], json!(1234));
    }

    /// `input` for a payment whose payload `currency` is `sent` (`None` = the key is absent) in a
    /// hub whose `payments.hub_currency` read answered `hub` (payments#38).
    fn input_with_currency(sent: Option<Value>, hub: Value) -> Value {
        let mut i = input(json!(1999));
        if let Some(c) = sent {
            i["payload"]["currency"] = c;
        }
        i["context"]["reads"] = json!({ "payments.hub_currency": [{ "currency": hub }] });
        i
    }

    fn bound_and_emitted_currency(out: &Output) -> (Value, Value) {
        let ins = out.operations.iter().find(|o| o.command == "payments._insert_payment").unwrap();
        (ins.params["currency"].clone(), out.events[0].payload["currency"].clone())
    }

    #[test]
    fn a_payment_without_currency_takes_the_hub_currency() {
        // payments#38: the assistant or an API integration leaves `currency` out — a yen hub's
        // payment must be stored AND announced in yen, not in euros.
        let out = create_payment_pure(input_with_currency(None, json!("JPY"))).unwrap();
        assert_eq!(bound_and_emitted_currency(&out), (json!("JPY"), json!("JPY")));
    }

    #[test]
    fn a_null_or_blank_currency_counts_as_absent() {
        for sent in [json!(null), json!(""), json!("   ")] {
            let out = create_payment_pure(input_with_currency(Some(sent.clone()), json!("KWD")))
                .unwrap();
            assert_eq!(bound_and_emitted_currency(&out), (json!("KWD"), json!("KWD")), "{sent}");
        }
    }

    #[test]
    fn an_explicit_currency_wins_over_the_hub_currency() {
        let out = create_payment_pure(input_with_currency(Some(json!("usd")), json!("JPY"))).unwrap();
        assert_eq!(bound_and_emitted_currency(&out), (json!("USD"), json!("USD")));
    }

    #[test]
    fn a_hub_that_never_set_its_currency_is_in_euros() {
        // The read always answers one row; a hub without the setting reads NULL (or '').
        for hub in [json!(null), json!(""), json!(" ")] {
            let out = create_payment_pure(input_with_currency(None, hub.clone())).unwrap();
            assert_eq!(bound_and_emitted_currency(&out), (json!("EUR"), json!("EUR")), "{hub}");
        }
        // No read at all (an older runtime) degrades the same way.
        let out = create_payment_pure(input(json!(1999))).unwrap();
        assert_eq!(bound_and_emitted_currency(&out), (json!("EUR"), json!("EUR")));
    }

    #[test]
    fn the_hub_currency_is_trimmed_and_uppercased() {
        let out = create_payment_pure(input_with_currency(None, json!(" jpy "))).unwrap();
        assert_eq!(bound_and_emitted_currency(&out), (json!("JPY"), json!("JPY")));
    }

    #[test]
    fn rejects_non_positive_amount() {
        assert!(create_payment_pure(input(json!(0))).is_err());
        assert!(create_payment_pure(input(json!(-5))).is_err());
    }

    #[test]
    fn parse_amount_cents_rounds_half_up_like_the_rest_of_the_hub() {
        // ADR-0123 §4: el ÚNICO modo de redondeo del hub es HALF_UP (money::round del SDK).
        // El half-even local con epsilon era el modo divergente: 12.5 → 12 (par); el sistema
        // entero redondea 12.5 → 13. Solo afecta al fallback de decimales colados (el schema
        // exige entero); el caso normal (entero/string-entero) no cambia.
        assert_eq!(parse_amount_cents(&json!("500")), Some(500));
        assert_eq!(parse_amount_cents(&json!(12.5)), Some(13)); // HALF_UP, no banker's
        assert_eq!(parse_amount_cents(&json!("abc")), None);
        assert_eq!(parse_amount_cents(&json!(-5)), None, "negativos rechazados (amount > 0)");
    }
}
