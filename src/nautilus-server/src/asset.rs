// Curated asset -> Pyth Hermes price-feed id map.
//
// We start with a small, hand-verified set (ids confirmed against Hermes
// /v2/price_feeds, asset_type=crypto). A job's `asset` must be one of these.
// Expand the table as more assets are supported.

// (symbol, Pyth feed id without the 0x prefix, the way Hermes returns it).
const FEEDS: &[(&str, &str)] = &[
    (
        "BTC",
        "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
    ),
    (
        "ETH",
        "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
    ),
    (
        "SOL",
        "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
    ),
    (
        "SUI",
        "23d7315113f5b1d3ba7a83604c44b94d79f4fd69af77f804fc7f920a6dc65744",
    ),
];

/// The Pyth feed id for a supported asset symbol (case-insensitive), or `None`.
pub fn feed_id(symbol: &str) -> Option<&'static str> {
    FEEDS
        .iter()
        .find(|(s, _)| s.eq_ignore_ascii_case(symbol))
        .map(|(_, id)| *id)
}

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn known_assets_resolve() {
        assert!(feed_id("BTC").is_some());
        assert_eq!(feed_id("btc"), feed_id("BTC")); // case-insensitive
        assert!(feed_id("SUI").is_some());
    }

    #[test]
    fn unknown_asset_is_none() {
        assert!(feed_id("DOGE").is_none());
        assert!(feed_id("").is_none());
    }
}
