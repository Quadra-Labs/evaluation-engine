/**
 * portfolio-roi — port of the Sui engine's `apps/finance/roi.rs`.
 *
 * An agent declares a USD allocation across assets and a list of rebalancing trades. Each trade
 * moves a whole-USD amount of the STARTING allocation from one asset to another, priced at the
 * start of the window — so a trade is a pure weight shift, not a timing bet, and the metric
 * measures allocation skill rather than execution luck.
 *
 *   endValue = sum over assets of  alloc[a] * endPrice[a] / startPrice[a]
 *   roiBps   = (endValue - startValue) * 10000 / startValue
 *   metric   = max(0, PERF_BASE + roiBps)
 *
 * The 1e-8 price scale cancels in the end/start ratio, so everything stays integer.
 *
 * WHY THIS LIVES HERE AND NOT IN quadra-core. Three reasons, and they compound:
 *
 *   Its inputs do not fit `ScorerInput`, which carries ONE start price and ONE end price. A
 *   portfolio needs a price pair per asset.
 *
 *   It produces a uint64 metric around 1e6, not a [0,100] score. That fits
 *   `SealedCompetition.EntryInput.score` (uint64) and `KIND_PERFORMANCE`, which deliberately does
 *   not write the Passport. It does NOT fit `JobEscrow.scoreJob`, whose score is a uint8 that
 *   `Passport.record` reverts above 100 — so this evaluator cannot be a paid job.
 *
 *   It is not publicly replayable, and quadra-core already says so: `portfolio-roi` sits in its
 *   NOT_REPLAYABLE table because the trades are private and stay private. The metric is TEE-signed
 *   and verified on chain; it simply cannot be recomputed by a stranger. Putting it in the scorer
 *   registry would make the verifier report it as replayable and then fail to replay it.
 *
 * ONE HONEST LIMITATION. The settlement carries a single `groundTruthValue` and a single FTSO
 * proof, so the on-chain oracle cross-check covers ONE of the portfolio's assets. The rest are
 * attested by the TEE signature alone. That is weaker than the price evaluators and is stated in
 * the README rather than hidden.
 */

/** Zero-ROI baseline. MUST equal `SealedCompetition.PERF_BASE`. */
export const PERF_BASE = 1_000_000n;

export interface Trade {
    readonly from: string;
    readonly to: string;
    readonly usd: bigint;
}

export interface PortfolioSubmission {
    /** asset -> starting USD allocation. */
    readonly start: ReadonlyMap<string, bigint>;
    readonly trades: readonly Trade[];
}

export type PortfolioFault = {
    readonly ok: false;
    readonly agentFault: true;
    readonly reason: string;
};

export type PortfolioVerdict =
    { readonly ok: true; readonly roiBps: bigint; readonly metric: bigint } | PortfolioFault;

const fault = (reason: string): PortfolioFault => ({ ok: false, agentFault: true, reason });

function asBigInt(value: unknown): bigint | undefined {
    if (typeof value === 'bigint') return value;
    if (typeof value === 'number' && Number.isInteger(value)) return BigInt(value);
    if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return BigInt(value.trim());
    return undefined;
}

/**
 * Pull the allocation and the trades out of a revealed submission.
 *
 * Both arrive as JSON ENCODED INTO A STRING FIELD, which is the Sui convention preserved verbatim:
 * the envelope carries a flat `Record<string, string>`, so a nested object has to be a string that
 * happens to parse. `agent_result.trades` was a string containing an array there too.
 */
export function parsePortfolioSubmission(
    revealed: Record<string, string>,
): PortfolioSubmission | PortfolioFault {
    const rawStart = revealed['portfolioStart'];
    if (rawStart === undefined) return fault('missing field "portfolioStart"');
    const rawTrades = revealed['trades'] ?? '[]';

    let startJson: unknown;
    try {
        startJson = JSON.parse(rawStart);
    } catch {
        return fault('"portfolioStart" is not a JSON object');
    }
    if (!startJson || typeof startJson !== 'object' || Array.isArray(startJson)) {
        return fault('"portfolioStart" must be a JSON object of asset to USD');
    }

    const start = new Map<string, bigint>();
    for (const [asset, value] of Object.entries(startJson as Record<string, unknown>)) {
        const usd = asBigInt(value);
        if (usd === undefined) return fault(`allocation for "${asset}" is not an integer`);
        if (usd < 0n) return fault(`allocation for "${asset}" is negative`);
        start.set(asset.toUpperCase(), usd);
    }

    let tradesJson: unknown;
    try {
        tradesJson = JSON.parse(rawTrades);
    } catch {
        return fault('"trades" is not a JSON array');
    }
    if (!Array.isArray(tradesJson)) return fault('"trades" must be a JSON array');

    const trades: Trade[] = [];
    for (const raw of tradesJson) {
        if (!raw || typeof raw !== 'object') return fault('a trade is not an object');
        const entry = raw as Record<string, unknown>;
        const usd = asBigInt(entry['usd']);
        if (typeof entry['from'] !== 'string' || typeof entry['to'] !== 'string') {
            return fault('a trade is missing "from" or "to"');
        }
        if (usd === undefined || usd < 0n) return fault('a trade has a non-integer "usd"');
        trades.push({
            from: entry['from'].toUpperCase(),
            to: entry['to'].toUpperCase(),
            usd,
        });
    }

    return { start, trades };
}

/** Every asset the valuation will need a price pair for. Sorted, so the order is deterministic. */
export function assetsOf(submission: PortfolioSubmission): string[] {
    const assets = new Set<string>(submission.start.keys());
    for (const trade of submission.trades) {
        assets.add(trade.from);
        assets.add(trade.to);
    }
    return [...assets].sort();
}

/**
 * Apply the trades and value the result. Pure and integer-only.
 *
 * Prices are in the app's 1e-8 fixed point. The Rust used a BTreeMap so its iteration order was
 * deterministic; the sort below is what preserves that — per-asset integer division truncates, so
 * a different visitation order really would produce a different total.
 */
export function computeMetric(
    submission: PortfolioSubmission,
    startPrices: ReadonlyMap<string, bigint>,
    endPrices: ReadonlyMap<string, bigint>,
): PortfolioVerdict {
    let startValue = 0n;
    for (const value of submission.start.values()) startValue += value;
    if (startValue <= 0n) return fault('empty portfolio (start value is zero)');

    const alloc = new Map<string, bigint>(submission.start);

    for (const trade of submission.trades) {
        if (trade.usd === 0n) continue;
        const from = alloc.get(trade.from) ?? 0n;
        // A hard reject rather than a partial fill, exactly as the Rust did: silently filling less
        // than asked would score a portfolio the agent did not choose.
        if (from < trade.usd) {
            return fault(`insufficient allocation in "${trade.from}" for a trade`);
        }
        alloc.set(trade.from, from - trade.usd);
        alloc.set(trade.to, (alloc.get(trade.to) ?? 0n) + trade.usd);
    }

    let endValue = 0n;
    for (const asset of [...alloc.keys()].sort()) {
        const usd = alloc.get(asset) ?? 0n;
        if (usd === 0n) continue;
        const start = startPrices.get(asset);
        const end = endPrices.get(asset);
        if (start === undefined || end === undefined || start <= 0n) {
            return fault(`missing start or end price for "${asset}"`);
        }
        endValue += (usd * end) / start;
    }

    const roiBps = ((endValue - startValue) * 10_000n) / startValue;
    const metric = PERF_BASE + roiBps;
    return { ok: true, roiBps, metric: metric <= 0n ? 0n : metric };
}
