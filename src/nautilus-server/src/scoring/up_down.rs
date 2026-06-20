// Up/Down scorer (Brier score).
//
// The agent says whether the asset will be higher at resolution than at delivery
// (isUp) with a confidence in [0.5, 1]. We score with the Brier rule the user
// specified, (p - outcome)^2, mapped to [0, 100]:
//   p_up    = isUp ? confidence : 1 - confidence   (probability it goes up)
//   outcome = end_price > start_price ? 1 : 0
//   score   = round((1 - (p_up - outcome)^2) * 100)
// So a perfect, certain call -> 100; a coin-flip (0.5) that's wrong -> 75; a
// certain call that's wrong -> 0. Confidence is taken to whole percent so the
// math is integer-only.

use super::{Scorer, ScoringError};
use crate::job::JobEnvelope;
use serde::Deserialize;
use tracing::info;

pub const CATEGORY_ID: &str = "up-down-guess";

#[derive(Debug, Deserialize)]
struct AgentGuess {
    #[serde(rename = "isUp")]
    is_up: bool,
    confidence: f64,
}

pub struct UpDownScorer;

impl Scorer for UpDownScorer {
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
        if !guess.confidence.is_finite() {
            return Err(ScoringError::BadAgentResult(
                "confidence is not a number".to_string(),
            ));
        }
        // Whole-percent confidence, clamped to the valid [0.5, 1] band.
        let conf_pct = ((guess.confidence * 100.0).round() as i64).clamp(50, 100);
        let outcome_up = end_price > start_price;

        info!(
            "up/down score: isUp {}, conf {}%, start {}, end {} (up={})",
            guess.is_up, conf_pct, start_price, end_price, outcome_up
        );
        Ok(score_brier(guess.is_up, conf_pct, outcome_up))
    }
}

fn score_brier(is_up: bool, conf_pct: i64, outcome_up: bool) -> u8 {
    let p_up = if is_up { conf_pct } else { 100 - conf_pct };
    let outcome = if outcome_up { 100 } else { 0 };
    let diff = p_up - outcome; // in [-100, 100]
                               // (diff/100)^2 * 100 = diff^2 / 100.
    let loss = (diff * diff) / 100; // 0..=100
    (100 - loss).clamp(0, 100) as u8
}

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn certain_and_right_is_perfect() {
        assert_eq!(score_brier(true, 100, true), 100);
        assert_eq!(score_brier(false, 100, false), 100);
    }

    #[test]
    fn coin_flip_wrong_is_75() {
        // p_up=0.5, outcome=0 -> (0.5)^2=0.25 -> 75.
        assert_eq!(score_brier(true, 50, false), 75);
        assert_eq!(score_brier(false, 50, true), 75);
    }

    #[test]
    fn certain_and_wrong_is_zero() {
        assert_eq!(score_brier(true, 100, false), 0);
        assert_eq!(score_brier(false, 100, true), 0);
    }

    #[test]
    fn confident_and_right_beats_unsure() {
        assert!(score_brier(true, 90, true) > score_brier(true, 60, true));
    }
}
