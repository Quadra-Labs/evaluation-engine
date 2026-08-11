/**
 * polymarket scoring — port of the Sui engine's `apps/polymarket/score.rs`.
 *
 * Three evaluators, each producing an integer score in [0,100]:
 *
 *   resolution — 100 if the agent's outcome equals the market's resolved winner, else 0.
 *   event      — coverage-weighted: correct guesses over the number of markets in the WHOLE
 *                event, so one lucky guess cannot reach 100 and answering more of the event pays.
 *   price      — Brier over probabilities, in basis-point integer space.
 *
 * Pure and integer-only, matching the price scorers' discipline. The float inputs are converted to
 * basis points immediately and never touched again.
 *
 * THESE SCORES CANNOT CURRENTLY BE SETTLED. Every settlement path in `JobEscrow` and
 * `SealedCompetition` calls `FtsoLib.checkGroundTruth`, which requires an FTSO anchor-feed Merkle
 * proof whose normalized value equals the signed `groundTruthValue`. A Polymarket outcome has no
 * FTSO feed, so there is no proof to attach. Attaching an unrelated feed's proof would satisfy the
 * contract and be a lie, so the engine refuses instead — see `evaluators/index.ts`. Landing these
 * for real needs an FDC `Web2Json` verification path in `contracts`, which is a different repo and
 * a redeploy.
 */

/** Outcome labels are compared case-insensitively, ignoring surrounding space ("YES" == "Yes"). */
export function outcomeEq(a: string, b: string): boolean {
    return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export interface Guess {
    readonly marketId: string;
    readonly outcome: string;
}

/** 100 when the agent's outcome matches the resolved winner, else 0. */
export function scoreResolution(agentOutcome: string, winner: string): number {
    return outcomeEq(agentOutcome, winner) ? 100 : 0;
}

/**
 * Coverage-weighted event score.
 *
 * `winners` maps each RESOLVED market id to its winning outcome. `totalMarkets` is the count for
 * the whole event, and it is the denominator on purpose: partial coverage caps the score, so an
 * agent that answers one market of ten correctly scores 10, not 100.
 */
export function scoreEvent(
    guesses: readonly Guess[],
    winners: ReadonlyMap<string, string>,
    totalMarkets: number,
): number {
    if (totalMarkets <= 0) return 0;
    let correct = 0;
    for (const guess of guesses) {
        const winner = winners.get(guess.marketId);
        if (winner !== undefined && outcomeEq(guess.outcome, winner)) correct += 1;
    }
    // Round half up, exactly as the Rust `(correct * 100 + total / 2) / total` did.
    const scaled = Math.floor((correct * 100 + Math.floor(totalMarkets / 2)) / totalMarkets);
    return Math.min(100, scaled);
}

/** A probability in [0,1] as integer basis points. Non-finite becomes 0; out of range clamps. */
export function toBps(probability: number): number {
    if (!Number.isFinite(probability)) return 0;
    return Math.min(10_000, Math.max(0, Math.round(probability * 10_000)));
}

/**
 * Brier score over probabilities: `100 - d^2 / 1e6` with `d` the basis-point error.
 *
 * Much flatter than the up/down Brier by design: an error of 0.10 costs one point, 0.50 costs 25,
 * and only a completely inverted call reaches 0.
 */
export function scorePrice(guess: number, actual: number): number {
    const d = Math.abs(toBps(guess) - toBps(actual));
    const penalty = Math.floor((d * d) / 1_000_000);
    return Math.min(100, Math.max(0, 100 - penalty));
}

/** `guesses` arrives as JSON encoded into a string field, the Sui convention. */
export function parseGuesses(raw: string | undefined): Guess[] | undefined {
    if (raw === undefined) return undefined;
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return undefined;
    }
    if (!Array.isArray(parsed)) return undefined;
    const out: Guess[] = [];
    for (const entry of parsed) {
        if (!entry || typeof entry !== 'object') return undefined;
        const row = entry as Record<string, unknown>;
        // Accept both spellings: the Sui payloads used snake_case.
        const marketId = row['marketId'] ?? row['market_id'];
        const outcome = row['outcome'];
        if (typeof marketId !== 'string' || typeof outcome !== 'string') return undefined;
        out.push({ marketId, outcome });
    }
    return out;
}
