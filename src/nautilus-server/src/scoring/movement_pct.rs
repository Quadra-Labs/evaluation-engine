// Movement-percentage scorer.
//
// The agent predicts how much the asset moves over the lifetime, as a signed
// percent (e.g. 5.0 = +5%, -3.0 = -3%). We compare it to the real move and score
// with a gentle curve so near-misses are not brutally punished (hitting the exact
// percent is genuinely hard):
//   actual = (end - start) / start              (in basis points, signed)
//   err    = |guess - actual|                   (basis points)
//   score  = round(100 * TOL^2 / (TOL^2 + err^2))
// err = 0 -> 100, err = TOL -> 50, and it tails off slowly (no cliff). Everything
// is integer: prices are 1e-8 fixed-point and the percent is taken to basis points.

use super::{Scorer, ScoringError};
use crate::job::JobEnvelope;
use serde::Deserialize;
use tracing::info;

pub const CATEGORY_ID: &str = "movement-percentage-guess";

// Tunable half-score point: an error of TOL basis points scores 50. 1000 bps = 10%.
const TOL_BPS: i128 = 1_000;

#[derive(Debug, Deserialize)]
struct AgentGuess {
    percentage: f64,
}

pub struct MovementPctScorer;

impl Scorer for MovementPctScorer {
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
        if !guess.percentage.is_finite() {
            return Err(ScoringError::BadAgentResult("percentage is not a number".to_string()));
        }
        if start_price == 0 {
            return Err(ScoringError::BadStartData("start_price is zero".to_string()));
        }

        let guess_bps = (guess.percentage * 100.0).round() as i128;
        let actual_bps =
            (end_price as i128 - start_price as i128) * 10_000 / start_price as i128;

        info!(
            "movement score: guess {}bps, actual {}bps (start {}, end {})",
            guess_bps, actual_bps, start_price, end_price
        );
        Ok(score_movement(guess_bps, actual_bps))
    }
}

fn score_movement(guess_bps: i128, actual_bps: i128) -> u8 {
    let err = (guess_bps - actual_bps).abs();
    let tol2 = TOL_BPS * TOL_BPS;
    ((100 * tol2) / (tol2 + err * err)) as u8
}

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn exact_is_perfect() {
        assert_eq!(score_movement(500, 500), 100);
    }

    #[test]
    fn error_of_tol_is_half() {
        // err = 1000 bps -> 100 * tol2 / (2*tol2) = 50.
        assert_eq!(score_movement(0, 1000), 50);
        assert_eq!(score_movement(1500, 500), 50);
    }

    #[test]
    fn decays_gently_not_cliff() {
        // err 5% -> 100/(1+0.25)=80; err 20% -> 100/(1+4)=20.
        assert_eq!(score_movement(0, 500), 80);
        assert_eq!(score_movement(0, 2000), 20);
    }

    #[test]
    fn sign_matters() {
        // predicting +5% when it fell 5% is a 10% error -> 50.
        assert_eq!(score_movement(500, -500), 50);
    }
}
