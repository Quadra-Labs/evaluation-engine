// price-range-guess enclave: registers the price-range scorer. The shared
// handlers in `endpoints.rs` use CATEGORY_ID + build_registry below.

use crate::scoring::price_range::{PriceRangeScorer, CATEGORY_ID as SCORER_ID};
use crate::scoring::ScorerRegistry;
use serde_repr::{Deserialize_repr, Serialize_repr};

pub const CATEGORY_ID: &str = SCORER_ID;

// Each signed message type gets its own intent scope so a signature for one kind
// of message can't be replayed as another.
#[derive(Serialize_repr, Deserialize_repr, Debug)]
#[repr(u8)]
pub enum IntentScope {
    Score = 0,
}

pub fn build_registry() -> ScorerRegistry {
    let mut registry = ScorerRegistry::new();
    registry.register(Box::new(PriceRangeScorer));
    registry
}
