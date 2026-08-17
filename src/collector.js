// Client for the "airlock-books" Scraper Studio collector.
//
// This calls the collector as a plain HTTP endpoint rather than shelling out to
// the `brightdata` CLI, because Airlock needs to drive runs from application
// code (and drives heals the same way — see src/airlock/heal.js).
//
// Single-URL runs use the "immediate" pair of endpoints:
//   POST /dca/trigger_immediate?collector=<id>   body: {"url": "..."}  -> 202 {response_id}
//   GET  /dca/get_result?response_id=<id>                              -> 202 while pending,
//                                                                         200 with the rows
//
// Notes that cost real time to discover, kept here so they are not rediscovered:
//   - the query param that selects the collector is `collector=`, not `scraper=`
//   - a pending poll returns HTTP 202 with {"pending": true}, not an empty 200
//   - multi-URL batches are a different pair (POST /dca/trigger -> GET /dca/dataset),
//     and the batch id comes back as `collection_id` (j_...), not `snapshot_id`

import { COLLECTOR_ID } from './config.js';
import { apiGet, apiPost } from './http.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Start a single-URL run. Resolves to the response_id used for polling. */
async function triggerRun(url, collectorId) {
  const { ok, status, text, data } = await apiPost('/dca/trigger_immediate', { url }, {
    query: { collector: collectorId },
  });

  if (!ok) throw new Error(`trigger_immediate failed (HTTP ${status}): ${text}`);

  const responseId = data?.response_id;
  if (!responseId) throw new Error(`trigger_immediate returned no response_id: ${text}`);

  return responseId;
}

/** Poll until the run finishes. Resolves to the parsed rows array. */
async function awaitResult(responseId, { pollIntervalMs, timeoutMs, onPoll }) {
  const deadline = Date.now() + timeoutMs;

  for (let attempt = 1; ; attempt += 1) {
    const { status, text, data } = await apiGet('/dca/get_result', {
      query: { response_id: responseId },
    });

    if (status === 200) return data;

    // 202 means the run is still going. Anything else is a real failure —
    // notably 422 output_schema_incompatible, when the collector's locked
    // output schema no longer matches its parse code.
    if (status !== 202) throw new Error(`get_result failed (HTTP ${status}): ${text}`);

    if (Date.now() >= deadline) {
      throw new Error(`Collector run ${responseId} did not finish within ${timeoutMs}ms`);
    }

    if (onPoll) onPoll(attempt);
    await sleep(pollIntervalMs);
  }
}

/**
 * Run the collector against one book URL and return its raw rows, exactly as
 * Scraper Studio produced them. No validation or reshaping happens here — that
 * is Airlock's job, and the naive consumer app deliberately skips it.
 */
export async function runCollector(url, options = {}) {
  const {
    collectorId = COLLECTOR_ID,
    pollIntervalMs = 5000,
    timeoutMs = 180000,
    onPoll,
  } = options;

  const startedAt = Date.now();
  const responseId = await triggerRun(url, collectorId);
  const rows = await awaitResult(responseId, { pollIntervalMs, timeoutMs, onPoll });

  return {
    rows,
    responseId,
    collectorId,
    url,
    durationMs: Date.now() - startedAt,
    fetchedAt: new Date().toISOString(),
  };
}
