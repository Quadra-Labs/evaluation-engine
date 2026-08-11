/**
 * lib.ts — the importable surface, separate from the two entrypoints.
 *
 * `main.ts` and `fcc/main.ts` both have side effects: they read the environment, dial the chain
 * and open a port. Anything that wants to USE this package — a local test, a future console
 * command, an operator script — needs the pieces without the process, which is what this file is.
 *
 * Deliberately absent: `bootTeeIdentity` is exported, but nothing here ever returns a private key
 * to a caller that did not already supply one.
 */

export { loadConfig, deployerKey, ConfigError, type EngineConfig } from './config.js';
export { bootTeeIdentity, assertUncompressed, type TeeIdentity } from './keys.js';
export { log, errorMessage, type LogLevel } from './log.js';
export { EngineError, statusFor, type EngineErrorKind } from './errors.js';

export {
    makeChainReader,
    coston2,
    type ChainReader,
    type Competition,
    type Job,
    type JobIntake,
    type Submission,
} from './chain/reads.js';
export {
    readRegisteredTee,
    readVtpmVerifier,
    bindTee,
    registerAttested,
    NO_TEE,
    type AttestArgs,
    type RegisteredTee,
} from './chain/registry.js';
export {
    jobEscrowAbi,
    sealedCompetitionAbi,
    teeRegistryAbi,
    vtpmVerifierAbi,
    KIND_SCORING,
    KIND_PERFORMANCE,
    PERF_BASE,
    MAX_ENTRIES,
} from './chain/abis.js';

export {
    makeDecryptor,
    makeEnvelopeDecryptor,
    makeNodeDecryptor,
    makeNodeEnvelopeDecryptor,
    localDecryptors,
    nodeDecryptors,
    nodeUnwrap,
    payloadFault,
    type Decryptor,
    type Decryptors,
    type PayloadFault,
} from './decrypt.js';

export { validateDelivery, type ValidationVerdict } from './validate.js';

export {
    buildJobResult,
    buildCompetitionResult,
    signJobSettlement,
    signCompetitionSettlement,
    OracleFaultError,
    UnknownEvaluatorError,
    type DecryptedEntry,
    type SettlementEntry,
    type SigningContext,
    type UnsignedCompetitionSettlement,
    type UnsignedJobSettlement,
} from './score.js';

export {
    jobSettleArgs,
    competitionSettleArgs,
    wireJobSettlement,
    wireCompetitionSettlement,
    type CompetitionSettleArgs,
    type JobSettleArgs,
    type WireCompetitionSettlement,
    type WireJobSettlement,
} from './settlement.js';

export {
    resolveForJob,
    resolveForCompetition,
    resolveForPortfolio,
    feedFromEvaluatorId,
    hasAnchorFeed,
    makePriceCache,
    MAX_PORTFOLIO_ASSETS,
    type PriceCache,
    type ResolvePolicy,
    type ResolvedPortfolio,
    type ResolvedWindow,
} from './resolve.js';

export { makeEngine, type Engine, type EngineDeps, type MarketScore } from './engine.js';
export { makeService, type ServiceDeps } from './server.js';

export {
    evaluatorTier,
    assertSettleable,
    scoreMarket,
    computeMetric,
    parsePortfolioSubmission,
    assetsOf,
    PERF_BASE as PORTFOLIO_PERF_BASE,
    MAX_POSITIONS,
    MAX_TRADES,
    PORTFOLIO_EVALUATOR,
    POLYMARKET_EVALUATORS,
    fetchMarket,
    fetchEventMarkets,
    priceAt,
    winnerOf,
    yesTokenId,
    PolymarketError,
    scoreResolution,
    scoreEvent,
    scorePrice,
    parseGuesses,
    outcomeEq,
    type EvaluatorTier,
    type Guess,
    type PortfolioSubmission,
    type PortfolioVerdict,
    type Trade,
} from './evaluators/index.js';

export {
    nonceFor,
    splitJwt,
    buildRegisterCall,
    fetchAttestationToken,
    SIMULATED_TOKEN,
    type RegisterCall,
} from './attestation.js';

// --- FCC ---------------------------------------------------------------------------------------

export { NodeClient } from './fcc/base/node.js';
export { ExtensionServer } from './fcc/base/server.js';
export {
    hexToBytes,
    bytesToHex,
    stringToBytes32Hex,
    bytes32HexToString,
} from './fcc/base/encoding.js';
export {
    Framework,
    logFor,
    stateVersionOf,
    EMPTY_BYTES32,
    STATUS_ERROR,
    STATUS_PENDING,
    STATUS_SUCCESS,
    type Action,
    type ActionResult,
    type DataFixed,
    type HandlerResult,
} from './fcc/base/types.js';
export {
    makeRegister,
    reportState,
    resetState,
    decodeSubjectId,
    type HandlerDeps,
} from './fcc/app/handlers.js';
export {
    VERSION as FCC_VERSION,
    OP_TYPE_EVALUATION,
    OP_COMMAND_VALIDATE,
    OP_COMMAND_SCORE_JOB,
    OP_COMMAND_SETTLE_COMP,
    EXTENSION_PORT,
    SIGN_PORT,
} from './fcc/app/config.js';
export { ProxyClient, NotReadyError, type TeeInfo } from './fcc/proxy.js';
