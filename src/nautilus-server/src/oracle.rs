// Quadra ground truth oracle.
//
// Instead of trusting a finalized result handed to us in the request, the
// engine reads the real value itself from Pyth. We ask Pyth Hermes for the
// price at a specific timestamp (the job resolution time) so the answer is
// well defined and does not depend on when the enclave happens to call.

use serde::Deserialize;
use tracing::info;

pub const PYTH_HERMES_HOST: &str = "hermes.pyth.network";

// Fixed-point scale for prices: every price is returned as an integer in 1e-8
// units (so $1.00 -> 100_000_000). This keeps precision for cheap assets and
// lets ratio/percentage scoring stay integer-only (no float drift in the
// reproducible build). 1e8 matches Pyth's common exponent.
pub const PRICE_SCALE: u128 = 100_000_000;

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
            OracleError::FeedNotFound(id) => {
                write!(f, "feed '{id}' was not in the oracle response")
            }
            OracleError::NonPositivePrice(p) => {
                write!(f, "oracle returned a non positive price: {p}")
            }
            OracleError::OutOfRange => {
                write!(f, "oracle price did not fit a u64 after normalizing")
            }
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

// To read a feed's price at a unix-seconds timestamp as a fixed-point integer in
// 1e-8 units (see PRICE_SCALE). Ratio/percentage scoring then stays integer-only.
pub async fn fetch_price_scaled(feed_id: &str, at_unix_seconds: u64) -> Result<u128, OracleError> {
    let (raw, expo) = fetch_raw(feed_id, at_unix_seconds).await?;
    normalize_to_scaled(raw, expo)
}

// The raw Pyth integer price plus its exponent for a feed at a timestamp.
async fn fetch_raw(feed_id: &str, at_unix_seconds: u64) -> Result<(i128, i32), OracleError> {
    let url = format!("https://{PYTH_HERMES_HOST}/v2/updates/price/{at_unix_seconds}");
    info!(
        "asking pyth for feed {} at unix second {}",
        feed_id, at_unix_seconds
    );

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

    Ok((raw, feed.price.expo))
}

// To turn Pyth's integer price plus exponent into 1e-8 fixed-point units. The
// real value is price * 10^expo; scaled = price * 10^(expo + 8).
pub fn normalize_to_scaled(price: i128, expo: i32) -> Result<u128, OracleError> {
    if price <= 0 {
        return Err(OracleError::NonPositivePrice(price));
    }

    let shift = expo + 8;
    let scaled: i128 = if shift >= 0 {
        let mul = 10i128
            .checked_pow(shift as u32)
            .ok_or(OracleError::OutOfRange)?;
        price.checked_mul(mul).ok_or(OracleError::OutOfRange)?
    } else {
        let div = 10i128
            .checked_pow((-shift) as u32)
            .ok_or(OracleError::OutOfRange)?;
        // Round to the nearest 1e-8 unit.
        (price + div / 2) / div
    };

    u128::try_from(scaled).map_err(|_| OracleError::OutOfRange)
}

// To turn a 1e-8 fixed-point price into whole US dollars (informational only,
// for the signed `finalized_price`). Saturates rather than failing.
pub fn scaled_to_usd(scaled: u128) -> u64 {
    let usd = (scaled + PRICE_SCALE / 2) / PRICE_SCALE;
    u64::try_from(usd).unwrap_or(u64::MAX)
}

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn normalizes_typical_btc_price() {
        // 60203.45 USD as Pyth sends it with expo -8 -> already in 1e-8 units.
        assert_eq!(
            normalize_to_scaled(6_020_345_000_000, -8).unwrap(),
            6_020_345_000_000
        );
    }

    #[test]
    fn scales_other_exponents_to_1e8() {
        // expo -2 means the integer is in cents; 6_020_345 * 10^(−2+8) = ...e8 units.
        assert_eq!(
            normalize_to_scaled(6_020_345, -2).unwrap(),
            6_020_345_000_000
        );
        // expo 0: 3 -> 3 * 1e8.
        assert_eq!(normalize_to_scaled(3, 0).unwrap(), 300_000_000);
    }

    #[test]
    fn keeps_sub_dollar_precision() {
        // $0.0000012 at expo -8 (raw 120) stays 120 in 1e-8 units, not rounded to 0.
        assert_eq!(normalize_to_scaled(120, -8).unwrap(), 120);
    }

    #[test]
    fn scaled_to_usd_rounds() {
        assert_eq!(scaled_to_usd(6_020_345_000_000), 60203); // 60203.45 -> 60203
        assert_eq!(scaled_to_usd(6_020_350_000_000), 60204); // 60203.50 -> 60204
    }

    #[test]
    fn rejects_non_positive_price() {
        assert!(matches!(
            normalize_to_scaled(0, -8),
            Err(OracleError::NonPositivePrice(_))
        ));
        assert!(matches!(
            normalize_to_scaled(-5, -8),
            Err(OracleError::NonPositivePrice(_))
        ));
    }
}
