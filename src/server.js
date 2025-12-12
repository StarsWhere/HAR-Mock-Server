const fs = require('fs');
const path = require('path');
const express = require('express');
const { loadConfig } = require('./config');

const runtimeConfig = loadConfig();

const rawBodySaver = (req, res, buf, encoding) => {
  if (buf && buf.length) {
    req.rawBody = buf.toString(encoding || 'utf8');
  } else if (!req.rawBody) {
    req.rawBody = '';
  }
};

function ensureHarExists(filePath) {
  if (!fs.existsSync(filePath)) {
    console.error(`[mock] HAR file not found at ${filePath}`);
    process.exit(1);
  }
}

function createEmptyDataset() {
  return {
    byMethod: new Map(),
    allGroups: [],
    totalEntries: 0,
    sources: [],
  };
}

function loadHarDatasets(filePaths = []) {
  const dataset = createEmptyDataset();
  const uniquePaths = filePaths.length ? Array.from(new Set(filePaths)) : runtimeConfig.harPaths;

  uniquePaths.forEach((harPath) => ingestHarFile(dataset, harPath));

  console.log(`[mock] Indexed ${dataset.totalEntries} total HAR entries`);
  console.log(`[mock] Unique URL combinations: ${dataset.allGroups.length}`);

  return dataset;
}

function loadHarDataset(filePath) {
  return loadHarDatasets([filePath]);
}

function ingestHarFile(dataset, filePath) {
  const resolvedPath = path.resolve(filePath);
  ensureHarExists(resolvedPath);

  const harRaw = fs.readFileSync(resolvedPath, 'utf8');
  let harJson;
  try {
    harJson = JSON.parse(harRaw);
  } catch (err) {
    console.error('[mock] Failed to parse HAR file:', err.message);
    process.exit(1);
  }

  const entries = Array.isArray(harJson?.log?.entries) ? harJson.log.entries : [];
  let ingested = 0;

  entries.forEach((entry, entryIndex) => {
    const normalized = normalizeHarEntry(entry, entryIndex, resolvedPath);
    if (!normalized) {
      return;
    }
    ingestNormalizedEntry(dataset, normalized);
    dataset.totalEntries += 1;
    ingested += 1;
  });

  dataset.sources.push({ path: resolvedPath, entryCount: ingested });
  console.log(`[mock] Loaded ${ingested} HAR entries from ${toRelativePath(resolvedPath)}`);
}

function ingestNormalizedEntry(dataset, normalized) {
  if (!dataset.byMethod.has(normalized.method)) {
    dataset.byMethod.set(normalized.method, new Map());
  }

  const methodGroup = dataset.byMethod.get(normalized.method);
  if (!methodGroup.has(normalized.canonicalUrlKey)) {
    const group = {
      key: normalized.canonicalUrlKey,
      method: normalized.method,
      path: normalized.path,
      pathSegments: normalized.pathSegments,
      queryKeys: normalized.queryKeys,
      queryString: normalized.queryString,
      entries: [],
    };
    methodGroup.set(group.key, group);
    dataset.allGroups.push(group);
  }

  const group = methodGroup.get(normalized.canonicalUrlKey);
  group.entries.push({
    payload: normalized.payload,
    response: normalized.response,
    sourceUrl: normalized.originalUrl,
    sourceFile: normalized.sourceFile,
    debugLabel: `${normalized.method} ${normalized.originalUrl}`,
  });
}

function normalizeHarEntry(entry, entryIndex, sourceFile) {
  const { request, response } = entry || {};
  if (!request || !request.url || !response) {
    return null;
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(request.url);
  } catch (err) {
    console.warn(`[mock] Skipping entry ${entryIndex} due to invalid URL: ${request.url}`);
    return null;
  }

  const method = (request.method || 'GET').toUpperCase();
  const pathName = parsedUrl.pathname || '/';
  const searchParams = parsedUrl.searchParams;
  const canonicalQuery = canonicalizeSearchParams(searchParams);
  const canonicalUrlKey = canonicalQuery ? `${pathName}?${canonicalQuery}` : pathName;
  const payload = normalizePayloadFromHar(request.postData);
  const normalizedResponse = normalizeHarResponse(response);

  return {
    method,
    originalUrl: `${method} ${parsedUrl.pathname}${parsedUrl.search}`,
    path: pathName,
    canonicalUrlKey,
    queryString: canonicalQuery,
    queryKeys: getUniqueSorted([...searchParams.keys()]),
    pathSegments: splitPathSegments(pathName),
    payload,
    response: normalizedResponse,
    sourceFile,
  };
}

function normalizeHarResponse(response = {}) {
  const headers = Array.isArray(response.headers)
    ? response.headers
        .filter((header) => header?.name && typeof header.value === 'string')
        .map((header) => ({ name: header.name, value: header.value }))
    : [];

  const content = response.content || {};
  return {
    status: response.status || 200,
    statusText: response.statusText || '',
    headers,
    mimeType: content.mimeType || null,
    encoding: content.encoding || null,
    bodyText: typeof content.text === 'string' ? content.text : '',
  };
}

function canonicalizeSearchParams(searchParams) {
  if (!searchParams) {
    return '';
  }
  const pairs = Array.from(searchParams.entries());
  if (!pairs.length) {
    return '';
  }
  pairs.sort((a, b) => {
    if (a[0] === b[0]) {
      return a[1].localeCompare(b[1]);
    }
    return a[0].localeCompare(b[0]);
  });
  const canonical = new URLSearchParams();
  pairs.forEach(([key, value]) => canonical.append(key, value));
  return canonical.toString();
}

function splitPathSegments(pathName = '/') {
  return pathName
    .split('/')
    .filter(Boolean)
    .map((segment) => decodeURIComponentSafe(segment));
}

function decodeURIComponentSafe(segment) {
  try {
    return decodeURIComponent(segment);
  } catch (err) {
    return segment;
  }
}

function normalizePayloadFromHar(postData) {
  if (!postData) {
    return createEmptyPayload();
  }

  const mime = (postData.mimeType || '').toLowerCase();
  const rawText = typeof postData.text === 'string' ? postData.text : '';

  if (mime.includes('application/json')) {
    const parsed = parseJsonSafe(rawText);
    if (parsed !== null) {
      return createStructuredPayloadFromObject(parsed, rawText);
    }
  }

  if (
    mime.includes('application/x-www-form-urlencoded') ||
    (Array.isArray(postData.params) && postData.params.length)
  ) {
    const params = new URLSearchParams();
    if (Array.isArray(postData.params) && postData.params.length) {
      postData.params.forEach(({ name, value }) => {
        if (name) {
          params.append(name, value ?? '');
        }
      });
    } else if (rawText) {
      rawText.split('&').forEach((pair) => {
        if (!pair) {
          return;
        }
        const [namePart, ...valueParts] = pair.split('=');
        if (!namePart) {
          return;
        }
        const decodedName = decodeURIComponentSafe(namePart);
        const decodedValue = decodeURIComponentSafe(valueParts.join('='));
        params.append(decodedName, decodedValue ?? '');
      });
    }
    return createStructuredPayloadFromSearchParams(params, rawText);
  }

  if (rawText) {
    return createTextPayload(rawText);
  }

  return createEmptyPayload();
}

function parseJsonSafe(value) {
  if (!value) {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch (err) {
    return null;
  }
}

function createStructuredPayloadFromObject(obj, rawText = '') {
  if (obj === null || obj === undefined) {
    return createEmptyPayload();
  }
  const pairs = [];
  flattenObjectToPairs(obj, '', pairs);
  return createStructuredPayload(pairs, rawText);
}

function createStructuredPayloadFromSearchParams(params, rawText = '') {
  const pairs = [];
  params.forEach((value, key) => {
    pairs.push({ key, value: value ?? '' });
  });
  return createStructuredPayload(pairs, rawText);
}

function flattenObjectToPairs(value, prefix, result) {
  const keyName = prefix || '__root__';
  if (value === null || value === undefined) {
    result.push({ key: keyName, value: '' });
    return;
  }

  if (Array.isArray(value)) {
    if (!value.length) {
      result.push({ key: `${keyName}[]`, value: '' });
      return;
    }
    value.forEach((item, index) => {
      const nextKey = prefix ? `${prefix}[${index}]` : `[${index}]`;
      flattenObjectToPairs(item, nextKey, result);
    });
    return;
  }

  if (typeof value === 'object') {
    const keys = Object.keys(value);
    if (!keys.length) {
      result.push({ key: keyName, value: '' });
      return;
    }
    keys.sort().forEach((childKey) => {
      const nextKey = prefix ? `${prefix}.${childKey}` : childKey;
      flattenObjectToPairs(value[childKey], nextKey, result);
    });
    return;
  }

  result.push({ key: keyName, value: String(value) });
}

function createStructuredPayload(pairs, rawText = '') {
  if (!pairs.length) {
    return createEmptyPayload();
  }

  const normalizedPairs = pairs.map(({ key, value }) => ({
    key: key || '__root__',
    value: value ?? '',
  }));

  const entries = normalizedPairs.map((pair) => `${pair.key}=${pair.value}`).sort();
  const keys = getUniqueSorted(normalizedPairs.map((pair) => pair.key));

  return {
    type: 'structured',
    entries,
    keys,
    rawText,
    fingerprint: `structured|${entries.join('|')}`,
  };
}

function createTextPayload(rawText = '') {
  return {
    type: 'text',
    text: rawText,
    fingerprint: `text|${rawText}`,
    entries: [],
    keys: [],
  };
}

function createEmptyPayload() {
  return {
    type: 'none',
    fingerprint: 'none',
    entries: [],
    keys: [],
    text: '',
  };
}

function buildRequestSignature(req) {
  const method = req.method.toUpperCase();
  const parsedUrl = new URL(req.originalUrl, 'http://placeholder');
  const pathName = parsedUrl.pathname || '/';
  const searchParams = parsedUrl.searchParams;
  const canonicalQuery = canonicalizeSearchParams(searchParams);
  const canonicalUrlKey = canonicalQuery ? `${pathName}?${canonicalQuery}` : pathName;
  const payload = normalizeIncomingPayload(req);

  return {
    method,
    canonicalUrlKey,
    pathSegments: splitPathSegments(pathName),
    queryKeys: getUniqueSorted([...searchParams.keys()]),
    payload,
    debugUrl: `${method} ${pathName}${parsedUrl.search}`,
  };
}

function normalizeIncomingPayload(req) {
  const contentType = (req.headers['content-type'] || '').toLowerCase();
  const body = req.body;

  if (body && typeof body === 'object' && !Buffer.isBuffer(body)) {
    return createStructuredPayloadFromObject(body, req.rawBody || JSON.stringify(body));
  }

  const rawBody = typeof body === 'string' ? body : req.rawBody || '';
  if (!rawBody) {
    return createEmptyPayload();
  }

  if (contentType.includes('application/json')) {
    const parsed = parseJsonSafe(rawBody);
    if (parsed !== null) {
      return createStructuredPayloadFromObject(parsed, rawBody);
    }
  }

  if (contentType.includes('application/x-www-form-urlencoded')) {
    const params = new URLSearchParams(rawBody);
    return createStructuredPayloadFromSearchParams(params, rawBody);
  }

  return createTextPayload(rawBody);
}

function findBestMatch(requestSignature, dataset, config) {
  const methodMap = dataset.byMethod.get(requestSignature.method);
  if (!methodMap || !methodMap.size) {
    return fallbackToAnyMethod(dataset, requestSignature, config);
  }

  const exactGroup = methodMap.get(requestSignature.canonicalUrlKey);
  if (exactGroup) {
    const exact = exactGroup.entries.find(
      (entry) => entry.payload.fingerprint === requestSignature.payload.fingerprint,
    );
    if (exact) {
      return { entry: exact, reason: 'exact', meta: { url: requestSignature.canonicalUrlKey } };
    }

    const bestPayloadMatch = selectBestPayloadMatch(exactGroup.entries, requestSignature.payload, config);
    if (bestPayloadMatch.entry) {
      return {
        entry: bestPayloadMatch.entry,
        reason: 'payload-similar',
        meta: {
          url: exactGroup.key,
          payloadScore: bestPayloadMatch.score,
        },
      };
    }
  }

  const bestGroup = selectBestUrlGroup(methodMap.values(), requestSignature, config);
  if (bestGroup.group) {
    const innerMatch = selectBestPayloadMatch(bestGroup.group.entries, requestSignature.payload, config);
    const entryToUse = innerMatch.entry || bestGroup.group.entries[0];
    return {
      entry: entryToUse,
      reason: 'url-similar',
      meta: {
        url: bestGroup.group.key,
        urlScore: bestGroup.score,
        payloadScore: innerMatch.score,
      },
    };
  }

  return fallbackToAnyMethod(dataset, requestSignature, config);
}

function fallbackToAnyMethod(dataset, requestSignature, config) {
  if (!dataset.allGroups.length) {
    return null;
  }
  const bestGroup = selectBestUrlGroup(dataset.allGroups, requestSignature, config);
  if (!bestGroup.group) {
    return null;
  }
  const innerMatch = selectBestPayloadMatch(bestGroup.group.entries, requestSignature.payload, config);
  const entryToUse = innerMatch.entry || bestGroup.group.entries[0];
  return {
    entry: entryToUse,
    reason: 'url-similar-any-method',
    meta: {
      url: bestGroup.group.key,
      urlScore: bestGroup.score,
      payloadScore: innerMatch.score,
    },
  };
}

function selectBestUrlGroup(groupsIterable, requestSignature, config = runtimeConfig) {
  const weights = config.matchWeights;
  let bestGroup = null;
  let bestScore = -Infinity;

  for (const group of groupsIterable) {
    const pathScore = computePathSimilarity(requestSignature.pathSegments, group.pathSegments, config);
    const queryScore = computeSetSimilarity(requestSignature.queryKeys, group.queryKeys);
    const combined = pathScore * weights.urlPath + queryScore * weights.urlQuery;
    if (combined > bestScore) {
      bestScore = combined;
      bestGroup = group;
    }
  }

  return { group: bestGroup, score: bestScore };
}

function selectBestPayloadMatch(entries, payload, config = runtimeConfig) {
  let bestEntry = null;
  let bestScore = -Infinity;

  entries.forEach((entry) => {
    const score = computePayloadSimilarity(payload, entry.payload, config);
    if (score > bestScore) {
      bestScore = score;
      bestEntry = entry;
    }
  });

  return { entry: bestEntry, score: bestScore };
}

function computeSetSimilarity(a = [], b = []) {
  if (!a.length && !b.length) {
    return 1;
  }
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  setA.forEach((value) => {
    if (setB.has(value)) {
      intersection += 1;
    }
  });
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

function computePathSimilarity(aSegments, bSegments, config = runtimeConfig) {
  const weights = config.matchWeights;
  const maxLen = Math.max(aSegments.length, bSegments.length, 1);
  let prefixMatches = 0;
  for (let i = 0; i < Math.min(aSegments.length, bSegments.length); i += 1) {
    if (aSegments[i] === bSegments[i]) {
      prefixMatches += 1;
    } else {
      break;
    }
  }

  const prefixScore = prefixMatches / maxLen;
  const fullPathA = `/${aSegments.join('/')}`;
  const fullPathB = `/${bSegments.join('/')}`;
  const editDistance = levenshtein(fullPathA, fullPathB);
  const distanceScore = 1 - editDistance / Math.max(fullPathA.length, fullPathB.length, 1);
  return prefixScore * weights.pathPrefix + distanceScore * weights.pathDistance;
}

function computePayloadSimilarity(a, b, config = runtimeConfig) {
  if (a.fingerprint === b.fingerprint) {
    return 1;
  }

  if (a.type === 'none' && b.type === 'none') {
    return 1;
  }

  if (a.type === 'structured' && b.type === 'structured') {
    return computeStructuredSimilarity(a, b, config);
  }

  if (a.type === 'text' && b.type === 'text') {
    return computeStringSimilarity(a.text, b.text);
  }

  if (a.type === 'none' || b.type === 'none') {
    return 0;
  }

  return config.matchWeights.payloadMismatchFloor;
}

function computeStructuredSimilarity(a, b, config = runtimeConfig) {
  const weights = config.matchWeights;
  const keyScore = computeSetSimilarity(a.keys, b.keys);
  const entryScore = computeSetSimilarity(a.entries, b.entries);
  return keyScore * weights.structuredKey + entryScore * weights.structuredEntry;
}

function computeStringSimilarity(a = '', b = '') {
  if (!a && !b) {
    return 1;
  }
  if (!a || !b) {
    return 0;
  }
  const distance = levenshtein(a, b);
  return 1 - distance / Math.max(a.length, b.length, 1);
}

function levenshtein(a, b) {
  const rows = b.length + 1;
  const cols = a.length + 1;
  const matrix = Array.from({ length: rows }, () => new Array(cols).fill(0));

  for (let i = 0; i < rows; i += 1) {
    matrix[i][0] = i;
  }
  for (let j = 0; j < cols; j += 1) {
    matrix[0][j] = j;
  }

  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(matrix[i - 1][j - 1], matrix[i][j - 1], matrix[i - 1][j]) + 1;
      }
    }
  }

  return matrix[rows - 1][cols - 1];
}

function getUniqueSorted(values = []) {
  return Array.from(new Set(values)).sort();
}

function toRelativePath(filePath) {
  if (!filePath) {
    return '';
  }
  return path.relative(process.cwd(), filePath) || filePath;
}

function sendHarResponse(res, harResponse) {
  const hopByHopHeaders = new Set(['content-length', 'transfer-encoding', 'content-encoding', 'connection']);
  harResponse.headers.forEach(({ name, value }) => {
    if (!name) {
      return;
    }
    const lower = name.toLowerCase();
    if (hopByHopHeaders.has(lower)) {
      return;
    }
    if (value !== undefined) {
      res.set(name, value);
    }
  });

  if (harResponse.mimeType && !res.get('Content-Type')) {
    res.set('Content-Type', harResponse.mimeType);
  }

  const bodyPayload =
    harResponse.encoding === 'base64'
      ? Buffer.from(harResponse.bodyText || '', 'base64')
      : harResponse.bodyText || '';

  res.status(harResponse.status || 200).send(bodyPayload);
}

function createApp(dataset, config = runtimeConfig) {
  const app = express();

  app.use(express.json({ limit: '10mb', type: ['application/json', 'application/*+json'], verify: rawBodySaver }));
  app.use(express.urlencoded({ extended: true, limit: '10mb', verify: rawBodySaver }));
  app.use(express.text({ type: '*/*', limit: '10mb', verify: rawBodySaver }));

  app.use((req, res) => {
    const requestSignature = buildRequestSignature(req);
    const match = findBestMatch(requestSignature, dataset, config);

    if (!match) {
      res.status(404).json({
        message: 'No HAR entries available for this request',
        request: requestSignature.debugUrl,
      });
      return;
    }

    res.set('x-mock-match', match.reason);
    if (match.meta?.url) {
      res.set('x-mock-source-url', match.meta.url);
    }
    if (Number.isFinite(match.meta?.urlScore)) {
      res.set('x-mock-url-score', match.meta.urlScore.toFixed(3));
    }
    if (Number.isFinite(match.meta?.payloadScore)) {
      res.set('x-mock-payload-score', match.meta.payloadScore.toFixed(3));
    }
    if (match.entry.sourceFile) {
      res.set('x-mock-source-file', toRelativePath(match.entry.sourceFile));
    }

    const sourceLabel = match.entry.sourceFile ? ` [${toRelativePath(match.entry.sourceFile)}]` : '';
    console.log(`[mock] ${requestSignature.debugUrl} -> ${match.entry.sourceUrl}${sourceLabel} (${match.reason})`);

    sendHarResponse(res, match.entry.response);
  });

  return app;
}

function startServer(config = runtimeConfig) {
  const dataset = loadHarDatasets(config.harPaths);
  if (dataset.sources.length) {
    console.log('[mock] HAR sources:');
    dataset.sources.forEach((source) => {
      console.log(`  • ${toRelativePath(source.path)} (${source.entryCount} entries)`);
    });
  }
  const app = createApp(dataset, config);
  app.listen(config.port, () => {
    console.log(`[mock] Listening on port ${config.port}`);
  });
}

if (require.main === module) {
  startServer();
}

module.exports = {
  createApp,
  loadHarDataset,
  loadHarDatasets,
  startServer,
};
