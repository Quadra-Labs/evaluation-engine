// up-down-guess enclave: registers the up/down (Brier) scorer. The shared
// handlers in `endpoints.rs` use CATEGORY_ID + build_registry below.

use crate::scoring::up_down::{UpDownScorer, CATEGORY_ID as SCORER_ID};
use crate::scoring::ScorerRegistry;
use serde_repr::{Deserialize_repr, Serialize_repr};

pub const CATEGORY_ID: &str = SCORER_ID;

#[derive(Serialize_repr, Deserialize_repr, Debug)]
#[repr(u8)]
pub enum IntentScope {
    Score = 0,
}

pub fn build_registry() -> ScorerRegistry {
    let mut registry = ScorerRegistry::new();
    registry.register(Box::new(UpDownScorer));
    registry
}
