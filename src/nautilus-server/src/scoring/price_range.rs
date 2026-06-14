// Price-range scorer (volatility-scaled by lifetime).
//
// The agent commits to a band [minPrice, maxPrice] for where the asset will be
// at resolution. If the real end price lands in the band -> 100. Otherwise the
// miss is judged against a tolerance that is start_price-relative and grows with
// the square root of the lifetime (price diffusion ~ sqrt(time)), so the agent
// can NOT game the denominator with their own band width (the old unfairness):
//   tol = start_price * sqrt(lifetime_seconds) / VOL_DENOM
//   score = max(0, 100 * (tol - miss) / tol)
//
// Prices are 1e-8 fixed-point integers (oracle::PRICE_SCALE); the agent's USD
// band is parsed once to the same units, then all math is integer.

use super::{usd_to_scaled, Scorer, ScoringError};
use crate::job::{self, JobEnvelope};
use serde::Deserialize;
use tracing::info;

pub const CATEGORY_ID: &str = "price-range-guess";

// Tunable: larger = tighter scoring. With sqrt(seconds)/10000, a ~1-day job
// tolerates ~3% drift, a ~30-day job ~16%, a 1-minute job ~0.07%.
const VOL_DENOM: u128 = 10_000;

#[derive(Debug, Deserialize)]
struct AgentGuess {
    #[serde(rename = "minPrice")]
    min_price: f64,
    #[serde(rename = "maxPrice")]
    max_price: f64,
}

pub struct PriceRangeScorer;

impl Scorer for PriceRangeScorer {
    fn category_id(&self) -> &str {
        CATEGORY_ID
    }

    fn score(
        &self,
        job: &JobEnvelope,
        start_price: u128,
        end_price: u128,
    ) -> Result<u8, ScoringError> {
        let guess: AgentGuess = serde_json::from_value(job.agent_result.clone())
            .map_err(|e| ScoringError::BadAgentResult(e.to_string()))?;
        let min = usd_to_scaled(guess.min_price)?;
        let max = usd_to_scaled(guess.max_price)?;
        if max <= min {
            return Err(ScoringError::BadAgentResult(
                "maxPrice must be greater than minPrice".to_string(),
            ));
        }
        if start_price == 0 {
            return Err(ScoringError::BadStartData("start_price is zero".to_string()));
        }

        let lifetime_ms = job::parse_lifetime_ms(&job.job_template.lifetime)
            .map_err(|e| ScoringError::BadAgentResult(e.to_string()))?;

        info!(
            "range score: band [{}, {}], start {}, end {}, lifetime_ms {}",
            min, max, start_price, end_price, lifetime_ms
        );
        Ok(score_range(min, max, start_price, end_price, lifetime_ms))
    }
}

fn score_range(min: u128, max: u128, start: u128, end: u128, lifetime_ms: u64) -> u8 {
    if end >= min && end <= max {
        return 100;
    }
    let miss = if end < min { min - end } else { end - max };

    let lifetime_secs = (lifetime_ms / 1000) as u128;
    let tol = start * isqrt(lifetime_secs) / VOL_DENOM;
    if tol == 0 || miss >= tol {
        return 0;
    }
    // miss in (0, tol) => 1..=99.
    (100 * (tol - miss) / tol) as u8
}

// Integer square root (Babylonian).
fn isqrt(n: u128) -> u128 {
    if n == 0 {
        return 0;
    }
    let mut x = n;
    let mut y = (x + 1) / 2;
    while y < x {
        x = y;
        y = (x + n / x) / 2;
    }
    x
}

#[cfg(test)]
mod test {
    use super::*;

    // 1 day of seconds -> isqrt ~ 293; tol = start * 293 / 10000 ~ 2.93%.
    const DAY_MS: u64 = 86_400_000;
    const START: u128 = 60_000 * 100_000_000; // $60k in 1e-8 units

    #[test]
    fn end_inside_band_is_perfect() {
        assert_eq!(score_range(START - 100, START + 100, START, START, DAY_MS), 100);
    }

    #[test]
    fn small_miss_scores_high() {
        // tol ~ 2.93% of start ~ 1758e8; a tiny miss above the band scores near 100.
        let band_hi = START + 100;
        let s = score_range(START - 100, band_hi, START, band_hi + 1_000_000, DAY_MS);
        assert!(s > 90 && s < 100, "got {s}");
    }

    #[test]
    fn miss_beyond_tolerance_is_zero() {
        // 50% away is way past the ~3% one-day tolerance.
        assert_eq!(score_range(START - 100, START + 100, START, START * 3 / 2, DAY_MS), 0);
    }

    #[test]
    fn longer_lifetime_is_more_forgiving() {
        let month = 30 * DAY_MS;
        let miss_end = START + START / 20; // 5% above band
        let day = score_range(START - 100, START + 100, START, miss_end, DAY_MS);
        let mon = score_range(START - 100, START + 100, START, miss_end, month);
        assert!(mon > day, "month {mon} should beat day {day}");
    }
}
