//! Handler WASM (Tier 2) del módulo `payments` — alta de pago saliente.
//! Portado de old_modules/m_payments (`PaymentService.create_payment` +
//! `generate_payment_reference`). Lógica pura, sin BD: recibe `{payload, context}`,
//! valida/normaliza y devuelve **intenciones** (commands `_`-prefijados del propio
//! módulo) que el host valida y ejecuta en UNA transacción, más el evento
//! `payments.payment.created`.
//!
//! Restricciones del runtime actual (sin lecturas pre-cargadas — patrón
//! `kitchen`/`tasks`, ADR-0020):
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
    let s = as_str(p.get(k).unwrap_or(&Value::Null));
    let s = s.trim().to_string();
    if s.is_empty() { d.to_string() } else { s }
}

fn day_from_now(now: &str) -> String {
    let date = now.split('T').next().unwrap_or("");
    let digits: String = date.chars().filter(|c| c.is_ascii_digit()).collect();
    if digits.len() >= 8 { digits[..8].to_string() } else { "00000000".to_string() }
}

struct Ctx {
    now: String,
    new_ids: Vec<String>,
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
    let ctx = Ctx {
        now: context.get("now").map(as_str).unwrap_or_default(),
        new_ids,
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

/// Parsea un importe (`Number` o `String` decimal) a céntimos `i64` con redondeo
/// half-even a 2 decimales (equivalente a `Decimal.quantize(0.01)` de Python).
/// Devuelve `None` si no es un decimal válido (signo, exponente, vacío, basura).
fn parse_amount_cents(v: &Value) -> Option<i64> {
    let s = match v {
        Value::Number(n) => n.to_string(),
        Value::String(s) => s.trim().to_string(),
        _ => return None,
    };
    if s.is_empty() || s.starts_with('-') || s.starts_with('+') {
        return None; // negativos rechazados (amount > 0); el '+' explícito tampoco se admite
    }
    let mut parts = s.splitn(2, '.');
    let int_part = parts.next().unwrap_or("");
    let frac_part = parts.next().unwrap_or("");
    if int_part.is_empty() && frac_part.is_empty() {
        return None;
    }
    if !int_part.chars().all(|c| c.is_ascii_digit())
        || !frac_part.chars().all(|c| c.is_ascii_digit())
        || int_part.len() > 13
    {
        return None; // exponentes, separadores raros u overflow
    }
    let int_val: i64 = if int_part.is_empty() { 0 } else { int_part.parse().ok()? };

    let frac: Vec<u8> = frac_part.bytes().map(|b| b - b'0').collect();
    let d1 = *frac.first().unwrap_or(&0) as i64;
    let d2 = *frac.get(1).unwrap_or(&0) as i64;
    let mut cents = int_val * 100 + d1 * 10 + d2;

    // Redondeo half-even sobre el resto (>2 decimales).
    let rest = &frac[frac.len().min(2)..];
    if !rest.is_empty() {
        let first = rest[0];
        let tail_nonzero = rest[1..].iter().any(|&d| d != 0);
        if first > 5 || (first == 5 && tail_nonzero) {
            cents += 1;
        } else if first == 5 && !tail_nonzero && cents % 2 != 0 {
            cents += 1; // half → al par
        }
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

    // payment_method_id: requerido, formato UUID. Existencia + is_active se guardan
    // en el SQL de `_insert_payment` (runtime sin lecturas pre-cargadas).
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
    let amount = cents_to_decimal(cents);

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
    let currency = str_or(&payload, "currency", "EUR").to_uppercase();
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
    // Bind numérico (f64 exacto a 2 decimales): SQLite NUMERIC y Postgres NUMERIC
    // (cast de asignación float8→numeric); el redondeo ya se hizo en céntimos i64.
    p.insert("amount".into(), json!(cents as f64 / 100.0));
    p.insert("currency".into(), json!(currency));
    p.insert("beneficiary_name".into(), json!(beneficiary_name));
    p.insert("beneficiary_iban".into(), json!(beneficiary_iban));
    p.insert("concept".into(), json!(concept));
    p.insert("supplier_invoice_ref".into(), json!(supplier_invoice_ref));

    let event = Event::new("payments.payment.created", json!({
        "sender": "payments",
        "payment_id": payment_id,
        "payment_method_id": method_id,
        "amount": amount,
        "currency": currency,
        "beneficiary_name": beneficiary_name,
        "payment_date": payment_date,
        "status": "draft",
        "day": day,
    }));

    Ok(Output {
        operations: vec![
            Operation::sql("payments._bump_counter", bump),
            Operation::sql("payments._insert_payment", p),
        ],
        events: vec![event],
    })
}
