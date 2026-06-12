// BTC price guess scorer.
//
// The agent commits to a price interval [minPrice, maxPrice] ahead of time.
// Once the real price is known we score how good that interval was:
//   - price inside the interval        -> 100
//   - price outside, but within one     -> linear decay down to 0
//     interval width of an edge
//   - price a full interval width away  -> 0
//
// All math is integer only. Prices are u64 (send them as whole units, for
// example cents, to avoid floats which can drift between platforms and break
// reproducible enclave builds.)

use super::{Scorer, ScoringError};
use crate::job::JobEnvelope;
use serde::Deserialize;
use serde_json::Value;
use tracing::info;

pub const CATEGORY_ID: &str = "btc-price-guess";

#[derive(Debug, Deserialize)]
struct AgentGuess {
    #[serde(rename = "minPrice")]
    min_price: u64,
    #[serde(rename = "maxPrice")]
    max_price: u64,
}

#[derive(Debug, Deserialize)]
struct FinalPrice {
    price: u64,
}

pub struct BtcPriceScorer;

impl Scorer for BtcPriceScorer {
    fn category_id(&self) -> &str {
        CATEGORY_ID
    }

    fn score(&self, job: &JobEnvelope, finalized_result: &Value) -> Result<u8, ScoringError> {
        let guess: AgentGuess = serde_json::from_value(job.agent_result.clone())
            .map_err(|e| ScoringError::BadAgentResult(e.to_string()))?;
        let final_price: FinalPrice = serde_json::from_value(finalized_result.clone())
            .map_err(|e| ScoringError::BadFinalizedResult(e.to_string()))?;

        info!(
            "scoring guess [{}, {}] against final price {}",
            guess.min_price, guess.max_price, final_price.price
        );

        score_interval(guess.min_price, guess.max_price, final_price.price)
    }
}

fn score_interval(min_price: u64, max_price: u64, price: u64) -> Result<u8, ScoringError> {
    if max_price <= min_price {
        return Err(ScoringError::BadAgentResult(
            "maxPrice must be greater than minPrice".to_string(),
        ));
    }

    if price >= min_price && price <= max_price {
        return Ok(100);
    }

    let width = max_price - min_price;
    let distance = if price < min_price {
        min_price - price
    } else {
        price - max_price
    };

    if distance >= width {
        return Ok(0);
    }

    // Bounded to 0..=99 here since distance is in (0, width), so it fits a u8.
    let score = 100 * (width - distance) / width;
    u8::try_from(score).map_err(|e| ScoringError::OutOfRange(e.to_string()))
}

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn price_inside_interval_is_perfect() {
        assert_eq!(score_interval(60000, 60100, 60050).unwrap(), 100);
        assert_eq!(score_interval(60000, 60100, 60000).unwrap(), 100);
        assert_eq!(score_interval(60000, 60100, 60100).unwrap(), 100);
    }

    #[test]
    fn price_just_outside_scores_high() {
        // width is 100, distance 1 -> 100 * 99 / 100 = 99
        assert_eq!(score_interval(60000, 60100, 59999).unwrap(), 99);
        assert_eq!(score_interval(60000, 60100, 60101).unwrap(), 99);
    }

    #[test]
    fn price_half_an_interval_away_scores_half() {
        // width 100, distance 50 -> 100 * 50 / 100 = 50
        assert_eq!(score_interval(60000, 60100, 59950).unwrap(), 50);
    }

    #[test]
    fn price_a_full_interval_away_is_zero() {
        // width 100, distance 100 -> 0
        assert_eq!(score_interval(60000, 60100, 59900).unwrap(), 0);
        assert_eq!(score_interval(60000, 60100, 70000).unwrap(), 0);
    }

    #[test]
    fn invalid_interval_is_rejected() {
        assert!(score_interval(60100, 60000, 60050).is_err());
        assert!(score_interval(60000, 60000, 60000).is_err());
    }
}
