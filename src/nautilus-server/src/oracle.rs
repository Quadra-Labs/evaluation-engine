// Quadra ground truth oracle.
//
// Instead of trusting a finalized result handed to us in the request, the
// engine reads the real value itself from Pyth. We ask Pyth Hermes for the
// price at a specific timestamp (the job resolution time) so the answer is
// well defined and does not depend on when the enclave happens to call.

use serde::Deserialize;
use tracing::info;

pub const PYTH_HERMES_HOST: &str = "hermes.pyth.network";

// Pyth price feed id for BTC/USD (no 0x prefix, the way Hermes returns it).
pub const BTC_USD_FEED_ID: &str =
    "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";

#[derive(Debug)]
pub enum OracleError {
    Request(String),
    Decode(String),
    FeedNotFound(String),
    NonPositivePrice(i128),
    OutOfRange,
}

impl std::fmt::Display for OracleError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OracleError::Request(e) => write!(f, "oracle request failed: {e}"),
            OracleError::Decode(e) => write!(f, "could not decode oracle response: {e}"),
            OracleError::FeedNotFound(id) => write!(f, "feed '{id}' was not in the oracle response"),
            OracleError::NonPositivePrice(p) => write!(f, "oracle returned a non positive price: {p}"),
            OracleError::OutOfRange => write!(f, "oracle price did not fit a u64 after normalizing"),
        }
    }
}

impl std::error::Error for OracleError {}

// Only the parts of the Hermes response we actually read.
#[derive(Debug, Deserialize)]
struct HermesResponse {
    parsed: Vec<ParsedFeed>,
}

#[derive(Debug, Deserialize)]
struct ParsedFeed {
    id: String,
    price: PythPrice,
}

#[derive(Debug, Deserialize)]
struct PythPrice {
    // Pyth sends the integer price and confidence as strings.
    price: String,
    expo: i32,
    publish_time: i64,
}

// To read the USD price in whole dollars for a feed at a unix seconds timestamp.
pub async fn fetch_price_usd(feed_id: &str, at_unix_seconds: u64) -> Result<u64, OracleError> {
    let url = format!("https://{PYTH_HERMES_HOST}/v2/updates/price/{at_unix_seconds}");
    info!("asking pyth for feed {} at unix second {}", feed_id, at_unix_seconds);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| OracleError::Request(e.to_string()))?;

    let response = client
        .get(url)
        .query(&[("ids[]", feed_id)])
        .send()
        .await
        .map_err(|e| OracleError::Request(e.to_string()))?;

    if !response.status().is_success() {
        return Err(OracleError::Request(format!(
            "pyth returned status {}",
            response.status()
        )));
    }

    let body: HermesResponse = response
        .json()
        .await
        .map_err(|e| OracleError::Decode(e.to_string()))?;

    let wanted = feed_id.trim_start_matches("0x");
    let feed = body
        .parsed
        .into_iter()
        .find(|f| f.id.eq_ignore_ascii_case(wanted))
        .ok_or_else(|| OracleError::FeedNotFound(feed_id.to_string()))?;

    let raw: i128 = feed
        .price
        .price
        .parse()
        .map_err(|e: std::num::ParseIntError| OracleError::Decode(e.to_string()))?;

    info!(
        "pyth price for {} is raw {} expo {} published at {}",
        wanted, raw, feed.price.expo, feed.price.publish_time
    );

    normalize_to_usd(raw, feed.price.expo)
}

// To turn Pyth's integer price plus exponent into whole US dollars, rounded to
// the nearest dollar. Pyth reports price * 10^expo as the real value, with expo
// usually negative (for example expo -8 means the integer is in 1e-8 units).
pub fn normalize_to_usd(price: i128, expo: i32) -> Result<u64, OracleError> {
    if price <= 0 {
        return Err(OracleError::NonPositivePrice(price));
    }

    let dollars: i128 = if expo < 0 {
        let scale = 10i128
            .checked_pow((-expo) as u32)
            .ok_or(OracleError::OutOfRange)?;
        // Add half the scale before dividing so we round to the nearest dollar.
        (price + scale / 2) / scale
    } else {
        let scale = 10i128.checked_pow(expo as u32).ok_or(OracleError::OutOfRange)?;
        price.checked_mul(scale).ok_or(OracleError::OutOfRange)?
    };

    u64::try_from(dollars).map_err(|_| OracleError::OutOfRange)
}

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn normalizes_typical_btc_price() {
        // 60203.45 USD as Pyth would send it with expo -8.
        assert_eq!(normalize_to_usd(6_020_345_000_000, -8).unwrap(), 60203);
    }

    #[test]
    fn rounds_to_nearest_dollar() {
        // 60203.50 rounds up to 60204 with expo -2.
        assert_eq!(normalize_to_usd(6_020_350, -2).unwrap(), 60204);
        // 60203.49 rounds down to 60203 with expo -2.
        assert_eq!(normalize_to_usd(6_020_349, -2).unwrap(), 60203);
    }

    #[test]
    fn handles_positive_exponent() {
        assert_eq!(normalize_to_usd(6, 4).unwrap(), 60000);
    }

    #[test]
    fn rejects_non_positive_price() {
        assert!(matches!(normalize_to_usd(0, -8), Err(OracleError::NonPositivePrice(_))));
        assert!(matches!(normalize_to_usd(-5, -8), Err(OracleError::NonPositivePrice(_))));
    }
}
