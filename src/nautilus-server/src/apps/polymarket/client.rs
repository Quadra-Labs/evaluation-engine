// Polymarket ground-truth client.
//
// Like oracle.rs (Pyth) the enclave reads the real value itself rather than trusting the request:
// market resolution + historical prices come straight from Polymarket's public Gamma and CLOB
// APIs. Two hosts (declared in allowed_endpoints.yaml):
//
//   Gamma  https://gamma-api.polymarket.com/markets/{id}   one market (resolution + token ids)
//          https://gamma-api.polymarket.com/events/{id}    one event with its nested markets
//   CLOB   https://clob.polymarket.com/prices-history       historical YES-token price series
//
// GOTCHA: Gamma returns `outcomes` / `outcomePrices` / `clobTokenIds` as JSON-ENCODED STRINGS
// (a string whose content is `["Yes","No"]`), not nested arrays, so we serde_json::from_str the
// inner string. Values are parsed leniently via serde_json::Value to tolerate the messy schema
// (string-or-number ids, array-or-object single responses).

use serde_json::Value;
use std::time::Duration;
use tracing::info;

pub const GAMMA_HOST: &str = "gamma-api.polymarket.com";
pub const CLOB_HOST: &str = "clob.polymarket.com";

#[derive(Debug)]
pub enum PolymarketError {
    /// Network / non-2xx — transient, the engine retries.
    Request(String),
    /// Malformed response we could not read — transient.
    Decode(String),
    /// The market/event/token was not found — transient (likely a bad id or propagation delay).
    NotFound(String),
    /// The market has not resolved (or the target time has no price yet) — transient; the engine
    /// retries until resolution, so a market resolving before prize release still scores.
    Unresolved(String),
}

impl std::fmt::Display for PolymarketError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PolymarketError::Request(e) => write!(f, "polymarket request failed: {e}"),
            PolymarketError::Decode(e) => write!(f, "could not decode polymarket response: {e}"),
            PolymarketError::NotFound(e) => write!(f, "polymarket not found: {e}"),
            PolymarketError::Unresolved(e) => write!(f, "market not resolved yet: {e}"),
        }
    }
}

impl std::error::Error for PolymarketError {}

/// One Polymarket market, normalized from Gamma's JSON-string fields.
#[derive(Debug, Clone)]
pub struct Market {
    pub id: String,
    pub closed: bool,
    pub outcomes: Vec<String>,
    pub outcome_prices: Vec<f64>,
    pub clob_token_ids: Vec<String>,
}

impl Market {
    /// The resolved winning outcome, or None when the market is not cleanly resolved yet. A
    /// resolved Polymarket market has `closed == true` and an `outcomePrices` entry of "1".
    pub fn winner(&self) -> Option<String> {
        if !self.closed || self.outcomes.is_empty() {
            return None;
        }
        let (idx, &max) = self
            .outcome_prices
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.partial_cmp(b.1).unwrap_or(std::cmp::Ordering::Equal))?;
        if max >= 0.99 {
            self.outcomes.get(idx).cloned()
        } else {
            None // closed but no decisive price (e.g. 50/50) -> treat as unresolved
        }
    }

    /// Index of the YES outcome (case-insensitive), defaulting to 0 for a binary market.
    fn yes_index(&self) -> usize {
        self.outcomes
            .iter()
            .position(|o| o.trim().eq_ignore_ascii_case("yes"))
            .unwrap_or(0)
    }

    /// The CLOB token id of the YES outcome, used to query the price series.
    pub fn yes_token_id(&self) -> Option<String> {
        self.clob_token_ids.get(self.yes_index()).cloned()
    }
}

/// Build the shared HTTP client. Forces IPv4 egress: Polymarket (Cloudflare) advertises IPv6 in
/// DNS, but many hosts — notably WSL2 — have no working IPv6 route, so a default client stalls on
/// the AAAA address until it times out. Binding a local IPv4 address pins the connection to A
/// records, the same `family: 4` discipline the repo's TypeScript clients use. A separate connect
/// timeout covers slow DNS without capping a legitimately slow body.
fn client() -> Result<reqwest::Client, PolymarketError> {
    reqwest::Client::builder()
        .local_address(std::net::IpAddr::V4(std::net::Ipv4Addr::UNSPECIFIED))
        // A real User-Agent: Polymarket fronts its API with Cloudflare bot management, which is
        // friendlier to a normal browser UA than a default client string.
        .user_agent("Mozilla/5.0 (compatible; QuadraEvalEngine/0.1; +https://polymarket.com)")
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| PolymarketError::Request(e.to_string()))
}

/// GET a URL and decode the body as JSON.
async fn get_json(url: &str) -> Result<Value, PolymarketError> {
    info!("polymarket GET {url}");
    let res = client()?.get(url).send().await.map_err(|e| PolymarketError::Request(e.to_string()))?;
    if !res.status().is_success() {
        return Err(PolymarketError::Request(format!("status {}", res.status())));
    }
    res.json::<Value>().await.map_err(|e| PolymarketError::Decode(e.to_string()))
}

/// Read a JSON-string-encoded array of strings (Gamma's `outcomes` / `clobTokenIds` shape).
fn parse_string_array(field: &str, v: &Value) -> Result<Vec<String>, PolymarketError> {
    let raw = v.get(field).and_then(|x| x.as_str()).ok_or_else(|| {
        PolymarketError::Decode(format!("market field '{field}' missing or not a JSON string"))
    })?;
    serde_json::from_str::<Vec<String>>(raw)
        .map_err(|e| PolymarketError::Decode(format!("market field '{field}' is not a JSON array: {e}")))
}

/// Read Gamma's `outcomePrices` (JSON-string array of decimal strings) into f64s.
fn parse_price_array(v: &Value) -> Result<Vec<f64>, PolymarketError> {
    parse_string_array("outcomePrices", v)?
        .iter()
        .map(|s| s.trim().parse::<f64>().map_err(|e| PolymarketError::Decode(e.to_string())))
        .collect()
}

/// A market `id` may arrive as a string or a number; normalize to a string.
fn read_id(v: &Value) -> String {
    match v.get("id") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        _ => String::new(),
    }
}

/// Build a normalized Market from one Gamma market object.
fn market_from_value(v: &Value) -> Result<Market, PolymarketError> {
    Ok(Market {
        id: read_id(v),
        closed: v.get("closed").and_then(|x| x.as_bool()).unwrap_or(false),
        outcomes: parse_string_array("outcomes", v)?,
        outcome_prices: parse_price_array(v)?,
        clob_token_ids: parse_string_array("clobTokenIds", v)?,
    })
}

/// Gamma single-object endpoints sometimes return a one-element array; unwrap either shape.
fn first_object(v: Value) -> Result<Value, PolymarketError> {
    match v {
        Value::Array(mut a) => a.drain(..).next().ok_or_else(|| PolymarketError::NotFound("empty array".into())),
        other => Ok(other),
    }
}

/// Fetch one market by its Gamma id.
pub async fn fetch_market(id: &str) -> Result<Market, PolymarketError> {
    let v = first_object(get_json(&format!("https://{GAMMA_HOST}/markets/{id}")).await?)?;
    market_from_value(&v)
}

/// Fetch every market belonging to an event by its Gamma id.
pub async fn fetch_event_markets(id: &str) -> Result<Vec<Market>, PolymarketError> {
    let v = first_object(get_json(&format!("https://{GAMMA_HOST}/events/{id}")).await?)?;
    let markets = v
        .get("markets")
        .and_then(|m| m.as_array())
        .ok_or_else(|| PolymarketError::NotFound(format!("event '{id}' has no markets array")))?;
    markets.iter().map(market_from_value).collect()
}

/// The CLOB YES-token price (in [0,1]) nearest to `target_ts` (unix seconds). Queries a +/-1h
/// window at 1-minute fidelity and picks the closest point.
pub async fn fetch_price_at(token_id: &str, target_ts: u64) -> Result<f64, PolymarketError> {
    let start = target_ts.saturating_sub(3_600);
    let end = target_ts + 3_600;
    let url = format!(
        "https://{CLOB_HOST}/prices-history?market={token_id}&startTs={start}&endTs={end}&fidelity=1"
    );
    let body = get_json(&url).await?;
    let history = body
        .get("history")
        .and_then(|h| h.as_array())
        .ok_or_else(|| PolymarketError::Decode("prices-history has no 'history' array".into()))?;

    let mut best: Option<(u64, f64)> = None;
    for point in history {
        let t = point.get("t").and_then(value_to_u64);
        let p = point.get("p").and_then(value_to_f64);
        if let (Some(t), Some(p)) = (t, p) {
            let closer = match best {
                None => true,
                Some((bt, _)) => t.abs_diff(target_ts) < bt.abs_diff(target_ts),
            };
            if closer {
                best = Some((t, p));
            }
        }
    }
    best.map(|(_, p)| p)
        .ok_or_else(|| PolymarketError::Unresolved(format!("no price for token {token_id} near {target_ts}")))
}

/// A JSON value that may be a number or a numeric string -> u64.
fn value_to_u64(v: &Value) -> Option<u64> {
    match v {
        Value::Number(n) => n.as_u64().or_else(|| n.as_f64().map(|f| f as u64)),
        Value::String(s) => s.trim().parse::<u64>().ok(),
        _ => None,
    }
}

/// A JSON value that may be a number or a numeric string -> f64.
fn value_to_f64(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse::<f64>().ok(),
        _ => None,
    }
}
