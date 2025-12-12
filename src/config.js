const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

let envBootstrapped = false;

const DEFAULTS = {
  port: 3000,
  harPaths: ['history.har'],
  matchWeights: {
    urlPath: 0.8,
    urlQuery: 0.2,
    pathPrefix: 0.6,
    pathDistance: 0.4,
    structuredKey: 0.4,
    structuredEntry: 0.6,
    payloadMismatchFloor: 0.1,
  },
};

function ensureEnvLoaded() {
  if (envBootstrapped) {
    return;
  }
  const envFile = path.resolve(process.cwd(), '.env');
  if (fs.existsSync(envFile)) {
    dotenv.config({ path: envFile });
  }
  envBootstrapped = true;
}

function loadConfig() {
  ensureEnvLoaded();
  const harPaths = resolveHarPaths();
  const port = numberFromEnv('PORT', DEFAULTS.port);
  const matchWeights = buildMatchWeights();

  return {
    port,
    harPaths,
    matchWeights,
  };
}

function resolveHarPaths() {
  const fromMulti = (process.env.HAR_PATHS || '').split(',').map((value) => value.trim()).filter(Boolean);
  const fromSingle = process.env.HAR_PATH ? [process.env.HAR_PATH.trim()] : [];
  const sources = fromMulti.length ? fromMulti : fromSingle.length ? fromSingle : DEFAULTS.harPaths;
  const resolved = sources
    .map((filePath) => path.resolve(process.cwd(), filePath))
    .filter((filePath) => filePath && typeof filePath === 'string');
  return Array.from(new Set(resolved));
}

function buildMatchWeights() {
  const url = normalizePair(
    numberFromEnv('MATCH_URL_PATH_WEIGHT', DEFAULTS.matchWeights.urlPath),
    numberFromEnv('MATCH_URL_QUERY_WEIGHT', DEFAULTS.matchWeights.urlQuery),
    DEFAULTS.matchWeights.urlPath,
    DEFAULTS.matchWeights.urlQuery,
  );

  const pathSimilarity = normalizePair(
    numberFromEnv('MATCH_PATH_PREFIX_WEIGHT', DEFAULTS.matchWeights.pathPrefix),
    numberFromEnv('MATCH_PATH_DISTANCE_WEIGHT', DEFAULTS.matchWeights.pathDistance),
    DEFAULTS.matchWeights.pathPrefix,
    DEFAULTS.matchWeights.pathDistance,
  );

  const structured = normalizePair(
    numberFromEnv('MATCH_STRUCTURED_KEY_WEIGHT', DEFAULTS.matchWeights.structuredKey),
    numberFromEnv('MATCH_STRUCTURED_ENTRY_WEIGHT', DEFAULTS.matchWeights.structuredEntry),
    DEFAULTS.matchWeights.structuredKey,
    DEFAULTS.matchWeights.structuredEntry,
  );

  const mismatchFloor = numberFromEnv(
    'MATCH_PAYLOAD_MISMATCH_FLOOR',
    DEFAULTS.matchWeights.payloadMismatchFloor,
  );

  return {
    urlPath: url.primary,
    urlQuery: url.secondary,
    pathPrefix: pathSimilarity.primary,
    pathDistance: pathSimilarity.secondary,
    structuredKey: structured.primary,
    structuredEntry: structured.secondary,
    payloadMismatchFloor: clampZeroToOne(mismatchFloor, DEFAULTS.matchWeights.payloadMismatchFloor),
  };
}

function normalizePair(primary, secondary, defaultPrimary, defaultSecondary) {
  const safePrimary = isFinite(primary) ? primary : defaultPrimary;
  const safeSecondary = isFinite(secondary) ? secondary : defaultSecondary;
  const total = safePrimary + safeSecondary;
  if (total <= 0) {
    const defaultsTotal = defaultPrimary + defaultSecondary;
    return {
      primary: defaultPrimary / defaultsTotal,
      secondary: defaultSecondary / defaultsTotal,
    };
  }
  return {
    primary: safePrimary / total,
    secondary: safeSecondary / total,
  };
}

function numberFromEnv(key, defaultValue) {
  const raw = process.env[key];
  if (raw === undefined) {
    return defaultValue;
  }
  const num = Number(raw);
  return Number.isFinite(num) ? num : defaultValue;
}

function clampZeroToOne(value, fallback) {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}

module.exports = {
  loadConfig,
};
