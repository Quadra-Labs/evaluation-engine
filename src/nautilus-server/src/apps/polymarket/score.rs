// Polymarket prediction scoring math.
//
// Three job types, each producing an integer score in [0, 100] the competition contract records
// (record_score) and ranks:
//
//   resolution  -> 100 if the agent's YES/NO equals the market's resolved winner, else 0.
//   event       -> coverage-weighted: round(correct_guesses / total_markets_in_event * 100), so
//                  guessing MORE of the event's markets correctly scores higher and one lucky
//                  guess cannot reach 100.
//   price       -> Brier: round(100 * (1 - (guess - actual)^2)) over probabilities in [0, 1].
//
// All three are pure + deterministic. The price curve runs in basis-point integer space so the
// build stays reproducible (no float scoring), mirroring the finance scorers' integer discipline.

use std::collections::BTreeMap;

/// One guess in an event job: a market id and the agent's predicted outcome.
#[derive(Debug, Clone, serde::Deserialize, PartialEq, Eq)]
pub struct Guess {
    pub market_id: String,
    pub outcome: String,
}

/// Compare two outcome labels (e.g. "YES" vs "Yes") case-insensitively, ignoring surrounding space.
fn outcome_eq(a: &str, b: &str) -> bool {
    a.trim().eq_ignore_ascii_case(b.trim())
}

/// Resolution (Job #1): 100 when the agent's outcome matches the resolved winner, else 0.
pub fn score_resolution(agent_outcome: &str, winner: &str) -> u8 {
    if outcome_eq(agent_outcome, winner) {
        100
    } else {
        0
    }
}

/// Event (Job #2), coverage-weighted. `winners` maps each RESOLVED market id in the event to its
/// winning outcome. `total_markets` is the number of markets in the whole event (the denominator,
/// so partial coverage caps the score). A guess for a market not in `winners` scores nothing.
/// `total_markets == 0` is a degenerate event -> 0.
pub fn score_event(guesses: &[Guess], winners: &BTreeMap<String, String>, total_markets: usize) -> u8 {
    if total_markets == 0 {
        return 0;
    }
    let correct = guesses
        .iter()
        .filter(|g| matches!(winners.get(&g.market_id), Some(w) if outcome_eq(&g.outcome, w)))
        .count();
    // round(correct / total * 100), clamped to 100 (a duplicate guess can't exceed coverage).
    let scaled = (correct as u64 * 100 + total_markets as u64 / 2) / total_markets as u64;
    scaled.min(100) as u8
}

/// Convert a probability in [0, 1] to integer basis points in [0, 10000] (rounded, clamped).
fn to_bps(p: f64) -> i64 {
    if !p.is_finite() {
        return 0;
    }
    let bps = (p * 10_000.0).round() as i64;
    bps.clamp(0, 10_000)
}

/// Price (Job #3), Brier in basis-point space: 100 * (1 - d^2) with d = |guess - actual| in [0, 1].
/// d^2 = (d_bps / 10000)^2, so score = 100 - d_bps^2 / 1_000_000 (integer), clamped to [0, 100].
pub fn score_price(guess: f64, actual: f64) -> u8 {
    let d = (to_bps(guess) - to_bps(actual)).unsigned_abs();
    let penalty = (d * d) / 1_000_000; // in [0, 100]
    (100u64.saturating_sub(penalty)).min(100) as u8
}

#[cfg(test)]
mod test {
    use super::*;

    fn winners(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs.iter().map(|&(k, v)| (k.to_string(), v.to_string())).collect()
    }
    fn guesses(pairs: &[(&str, &str)]) -> Vec<Guess> {
        pairs
            .iter()
            .map(|&(m, o)| Guess { market_id: m.to_string(), outcome: o.to_string() })
            .collect()
    }

    #[test]
    fn resolution_is_all_or_nothing_case_insensitive() {
        assert_eq!(score_resolution("YES", "Yes"), 100);
        assert_eq!(score_resolution(" no ", "No"), 100);
        assert_eq!(score_resolution("YES", "No"), 0);
    }

    #[test]
    fn event_is_coverage_weighted() {
        let w = winners(&[("m1", "Yes"), ("m2", "No"), ("m3", "Yes"), ("m4", "No")]);
        // 3 correct out of 4 total markets -> 75.
        let g = guesses(&[("m1", "Yes"), ("m2", "No"), ("m3", "Yes"), ("m4", "Yes")]);
        assert_eq!(score_event(&g, &w, 4), 75);
        // One correct guess out of 4 total markets -> 25 (cannot reach 100 with a single guess).
        assert_eq!(score_event(&guesses(&[("m1", "Yes")]), &w, 4), 25);
        // All four correct -> 100.
        let all = guesses(&[("m1", "Yes"), ("m2", "No"), ("m3", "Yes"), ("m4", "No")]);
        assert_eq!(score_event(&all, &w, 4), 100);
    }

    #[test]
    fn event_ignores_guesses_for_unknown_markets() {
        let w = winners(&[("m1", "Yes"), ("m2", "No")]);
        // "m9" is not a resolved market in the event -> contributes nothing.
        let g = guesses(&[("m1", "Yes"), ("m9", "Yes")]);
        assert_eq!(score_event(&g, &w, 2), 50);
        assert_eq!(score_event(&[], &w, 2), 0);
        assert_eq!(score_event(&g, &w, 0), 0);
    }

    #[test]
    fn price_brier_rewards_closeness() {
        assert_eq!(score_price(0.62, 0.62), 100); // exact
        assert_eq!(score_price(0.5, 0.5), 100);
        // off by 0.10 -> 100 - 1000^2/1e6 = 100 - 1 = 99.
        assert_eq!(score_price(0.60, 0.50), 99);
        // off by 0.50 -> 100 - 5000^2/1e6 = 100 - 25 = 75.
        assert_eq!(score_price(1.0, 0.5), 75);
        // off by 1.0 -> 100 - 10000^2/1e6 = 0.
        assert_eq!(score_price(1.0, 0.0), 0);
    }

    #[test]
    fn price_clamps_out_of_range_inputs() {
        // Inputs outside [0,1] are clamped before scoring.
        assert_eq!(score_price(1.5, 1.0), 100);
        assert_eq!(score_price(-0.2, 0.0), 100);
        assert_eq!(score_price(f64::NAN, 0.0), 100); // NaN -> 0 bps == actual 0
    }
}
