// Portfolio ROI math.
//
// An agent starts with a USD allocation per asset (e.g. { BTC: 5000, ETH: 5000 }) and submits
// rebalancing trades, each moving a whole-USD amount of start-allocation from one asset to
// another (priced at the START of the window, so a trade is a pure weight shift, not a timing
// bet). After the window we value the resulting allocation at END prices:
//
//   end_value = sum over assets a of  alloc[a] * endPrice[a] / startPrice[a]
//   roi_bps   = (end_value - start_value) * 10000 / start_value
//   metric    = max(0, PERF_BASE + roi_bps)
//
// Prices are the oracle's 1e-8 fixed-point integers (oracle::PRICE_SCALE); the scale cancels in
// the end/start ratio, so the math stays integer (i128) and deterministic for reproducible PCRs.
// `metric` is what the competition contract records and ranks; PERF_BASE matches the Move
// `competition::perf_base()`.

use serde::Deserialize;
use std::collections::BTreeMap;
use std::fmt;

/// Zero-ROI baseline; MUST equal the Move `competition::PERF_BASE`.
pub const PERF_BASE: u64 = 1_000_000;

/// One rebalancing trade: move `usd` of start-allocation from `from` to `to`.
#[derive(Debug, Deserialize, Clone)]
pub struct Trade {
    pub from: String,
    pub to: String,
    pub usd: u64,
}

#[derive(Debug, PartialEq, Eq)]
pub enum PortfolioError {
    EmptyPortfolio,
    Insufficient(String),
    MissingPrice(String),
}

impl fmt::Display for PortfolioError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PortfolioError::EmptyPortfolio => write!(f, "empty portfolio (start value is zero)"),
            PortfolioError::Insufficient(a) => {
                write!(f, "insufficient allocation in '{a}' for a trade")
            }
            PortfolioError::MissingPrice(a) => write!(f, "missing start/end price for '{a}'"),
        }
    }
}

impl std::error::Error for PortfolioError {}

/// Apply the trades to the starting allocation and value the result at end prices. Returns
/// `(roi_bps, metric)`. Pure + integer-only. `start_prices`/`end_prices` are 1e-8 fixed-point.
pub fn compute_metric(
    portfolio_start: &BTreeMap<String, u64>,
    trades: &[Trade],
    start_prices: &BTreeMap<String, u128>,
    end_prices: &BTreeMap<String, u128>,
) -> Result<(i128, u64), PortfolioError> {
    let start_value: i128 = portfolio_start.values().map(|&v| v as i128).sum();
    if start_value <= 0 {
        return Err(PortfolioError::EmptyPortfolio);
    }

    let mut alloc: BTreeMap<String, i128> = portfolio_start
        .iter()
        .map(|(k, &v)| (k.clone(), v as i128))
        .collect();

    for t in trades {
        if t.usd == 0 {
            continue;
        }
        let usd = t.usd as i128;
        let from_bal = alloc.get(&t.from).copied().unwrap_or(0);
        if from_bal < usd {
            return Err(PortfolioError::Insufficient(t.from.clone()));
        }
        alloc.insert(t.from.clone(), from_bal - usd);
        *alloc.entry(t.to.clone()).or_insert(0) += usd;
    }

    let mut end_value: i128 = 0;
    for (asset, &usd) in &alloc {
        if usd == 0 {
            continue;
        }
        let sp = *start_prices
            .get(asset)
            .ok_or_else(|| PortfolioError::MissingPrice(asset.clone()))? as i128;
        let ep = *end_prices
            .get(asset)
            .ok_or_else(|| PortfolioError::MissingPrice(asset.clone()))? as i128;
        if sp <= 0 {
            return Err(PortfolioError::MissingPrice(asset.clone()));
        }
        end_value += usd * ep / sp;
    }

    let roi_bps = (end_value - start_value) * 10_000 / start_value;
    let metric_signed = PERF_BASE as i128 + roi_bps;
    let metric = if metric_signed <= 0 {
        0
    } else {
        metric_signed as u64
    };
    Ok((roi_bps, metric))
}

#[cfg(test)]
mod test {
    use super::*;

    // Prices in 1e-8 fixed-point (oracle::PRICE_SCALE), the same units the oracle returns.
    fn scaled(pairs: &[(&str, u128)]) -> BTreeMap<String, u128> {
        pairs
            .iter()
            .map(|&(k, v)| (k.to_string(), v * 100_000_000))
            .collect()
    }
    fn usd(pairs: &[(&str, u64)]) -> BTreeMap<String, u64> {
        pairs.iter().map(|&(k, v)| (k.to_string(), v)).collect()
    }

    #[test]
    fn flat_prices_no_trades_is_zero_roi() {
        let (roi, metric) = compute_metric(
            &usd(&[("BTC", 5000), ("ETH", 5000)]),
            &[],
            &scaled(&[("BTC", 60000), ("ETH", 3000)]),
            &scaled(&[("BTC", 60000), ("ETH", 3000)]),
        )
        .unwrap();
        assert_eq!(roi, 0);
        assert_eq!(metric, PERF_BASE);
    }

    #[test]
    fn shifting_into_the_winner_beats_holding() {
        let start = usd(&[("BTC", 5000), ("ETH", 5000)]);
        let sp = scaled(&[("BTC", 60000), ("ETH", 3000)]);
        let ep = scaled(&[("BTC", 72000), ("ETH", 3000)]); // BTC +20%, ETH flat
        let (hold_roi, _) = compute_metric(&start, &[], &sp, &ep).unwrap();
        assert_eq!(hold_roi, 1000); // 50/50 -> +10%

        let trades = vec![Trade {
            from: "ETH".into(),
            to: "BTC".into(),
            usd: 5000,
        }];
        let (roi, metric) = compute_metric(&start, &trades, &sp, &ep).unwrap();
        assert_eq!(roi, 2000); // all-in BTC -> +20%
        assert_eq!(metric, PERF_BASE + 2000);
        assert!(roi > hold_roi);
    }

    #[test]
    fn a_loss_floors_below_perf_base() {
        let (roi, metric) = compute_metric(
            &usd(&[("BTC", 10000)]),
            &[],
            &scaled(&[("BTC", 60000)]),
            &scaled(&[("BTC", 54000)]), // -10%
        )
        .unwrap();
        assert_eq!(roi, -1000);
        assert_eq!(metric, PERF_BASE - 1000);
    }

    #[test]
    fn overspending_an_asset_is_rejected() {
        let trades = vec![Trade {
            from: "ETH".into(),
            to: "BTC".into(),
            usd: 6000,
        }];
        let err = compute_metric(
            &usd(&[("BTC", 5000), ("ETH", 5000)]),
            &trades,
            &scaled(&[("BTC", 60000), ("ETH", 3000)]),
            &scaled(&[("BTC", 60000), ("ETH", 3000)]),
        )
        .unwrap_err();
        assert_eq!(err, PortfolioError::Insufficient("ETH".to_string()));
    }
}
