// Quadra scoring engine.
//
// A Scorer turns one job into an integer score in [0, 100]. Each category has
// exactly one scorer. The registry maps a category id to its scorer so the
// process_data endpoint can look up the right one and reject anything else.

pub mod btc_price;

use crate::job::JobEnvelope;
use fastcrypto::encoding::{Encoding, Hex};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;
use std::collections::HashMap;
use std::fmt;

// A 32 byte Sui address. It shows up as a "0x" hex string in JSON responses so
// it is readable, but serializes as 32 raw bytes under BCS so the signed bytes
// line up with a Move `address` on the verifier.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SuiAddress([u8; 32]);

impl SuiAddress {
    pub fn new(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }
}

impl Serialize for SuiAddress {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        if serializer.is_human_readable() {
            serializer.serialize_str(&format!("0x{}", Hex::encode(self.0)))
        } else {
            // Fixed array serializes as 32 raw bytes under BCS, no length prefix.
            self.0.serialize(serializer)
        }
    }
}

impl<'de> Deserialize<'de> for SuiAddress {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        if deserializer.is_human_readable() {
            let text = String::deserialize(deserializer)?;
            let trimmed = text.strip_prefix("0x").unwrap_or(&text);
            let bytes = Hex::decode(trimmed).map_err(serde::de::Error::custom)?;
            let array: [u8; 32] = bytes
                .try_into()
                .map_err(|_| serde::de::Error::custom("expected 32 bytes"))?;
            Ok(SuiAddress(array))
        } else {
            Ok(SuiAddress(<[u8; 32]>::deserialize(deserializer)?))
        }
    }
}

// The signed payload the enclave returns. The field order and types here must
// match the Move verifier exactly, because the signature is over the BCS bytes
// of this struct wrapped in an IntentMessage. finalized_price is the ground
// truth the engine resolved, included so callers can see what it scored against.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ScoreResult {
    pub agent_id: SuiAddress,
    pub category_id: String,
    pub job_id: String,
    pub score: u8,
    pub finalized_price: u64,
}

#[derive(Debug)]
pub enum ScoringError {
    BadAgentResult(String),
    BadFinalizedResult(String),
    OutOfRange(String),
}

impl fmt::Display for ScoringError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ScoringError::BadAgentResult(e) => write!(f, "could not read agent_result: {e}"),
            ScoringError::BadFinalizedResult(e) => write!(f, "could not read finalized_result: {e}"),
            ScoringError::OutOfRange(e) => write!(f, "score is out of range: {e}"),
        }
    }
}

impl std::error::Error for ScoringError {}

pub trait Scorer: Send + Sync {
    fn category_id(&self) -> &str;
    // finalized_result is the ground truth the engine resolved (for example the
    // real price read from the oracle), shaped as JSON so each category reads
    // whatever fields it needs.
    fn score(&self, job: &JobEnvelope, finalized_result: &Value) -> Result<u8, ScoringError>;
}

pub struct ScorerRegistry {
    scorers: HashMap<String, Box<dyn Scorer>>,
}

impl ScorerRegistry {
    pub fn new() -> Self {
        Self { scorers: HashMap::new() }
    }

    // To add a scorer under its own category id.
    pub fn register(&mut self, scorer: Box<dyn Scorer>) {
        let category = scorer.category_id().to_string();
        self.scorers.insert(category, scorer);
    }

    pub fn get(&self, category_id: &str) -> Option<&dyn Scorer> {
        self.scorers.get(category_id).map(|boxed| boxed.as_ref())
    }
}

impl Default for ScorerRegistry {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod test {
    use super::*;

    fn sample_result() -> ScoreResult {
        ScoreResult {
            agent_id: SuiAddress::new([0xab; 32]),
            category_id: "btc-price-guess".to_string(),
            job_id: "job-1".to_string(),
            score: 100,
            finalized_price: 63276,
        }
    }

    #[test]
    fn address_is_hex_string_in_json() {
        let json = serde_json::to_string(&sample_result()).unwrap();
        assert!(json.contains(&format!("\"agent_id\":\"0x{}\"", "ab".repeat(32))));
        assert!(json.contains("\"finalized_price\":63276"));
    }

    #[test]
    fn address_is_raw_32_bytes_in_bcs() {
        let bytes = bcs::to_bytes(&sample_result()).unwrap();
        // The first 32 bytes are the address, with no length prefix.
        assert_eq!(&bytes[..32], &[0xab; 32]);
    }

    #[test]
    fn json_round_trips_through_address() {
        let json = serde_json::to_string(&sample_result()).unwrap();
        let back: ScoreResult = serde_json::from_str(&json).unwrap();
        assert_eq!(back.agent_id, SuiAddress::new([0xab; 32]));
        assert_eq!(back.finalized_price, 63276);
    }
}
