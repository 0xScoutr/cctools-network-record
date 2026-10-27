/**
 * Per-source health latches for a job that reads several upstreams in one
 * run. A job can answer success because most of its sources worked while one
 * of them has been dead for days; this counts CONSECUTIVE failing runs per
 * source and alerts once on the transition into failing (after
 * `failThreshold` runs) and once on recovery, with nothing in between.
 *
 * State is one cache-store entry per caller, with no expiry: durable counter
 * state, not a cache. It cannot report a job that stops running at all; that
 * needs a check from outside the process (the public status file, for one).
 */

import { sendAlert, sendPage } from "./alerts";
import { getCacheEntry, setCached } from "./cache-store";

export interface FeedOutcome {
  id: string;
  label: string;
  /** Did this source produce usable output this run? */
  ok: boolean;
  /** No signal this run: the counter is kept as it is and it never alerts. */
  skipped?: boolean;
  /** Shown in the alert line: what is wrong, or what came back on recovery. */
  detail?: string;
}

export interface FeedHealthConfig {
  /** Cache-store key holding the counters. Unique per caller. */
  stateKey: string;
  /** `source` tag on the cache write. */
  cacheSource: string;
  /** Consecutive failing runs before alerting. */
  failThreshold: number;
  /** How long failThreshold runs actually is, e.g. "~30min", so the reader knows how stale the data is. */
  downWindow: string;
  downTitle: string;
  recoveredTitle: string;
  /** Page now instead of waiting for the summary: for data published under the operator's name. */
  page?: boolean;
  /** What to do about a failing source, added under its line. Null when there is nothing more specific. */
  action?: (outcome: FeedOutcome) => string | null;
}

type HealthEntry = { consecutiveFailures: number; alerted: boolean };
type HealthMap = Record<string, HealthEntry>;

/** "- label (id): 6 consecutive failing runs; detail", or "- label (id): detail". */
function line(o: FeedOutcome, runs?: number): string {
  const runsPart = runs != null ? `: ${runs} consecutive failing runs` : "";
  const detailPart = o.detail ? `${runs != null ? "; " : ": "}${o.detail}` : "";
  return `- ${o.label} (${o.id})${runsPart}${detailPart}`;
}

/**
 * Update the per-source counters from this run's outcomes and send the
 * failing and recovered transitions. Counters are written every run so a
 * streak keeps counting run over run.
 */
export async function checkFeedHealth(config: FeedHealthConfig, outcomes: FeedOutcome[]): Promise<void> {
  const state = await getCacheEntry<HealthMap>(config.stateKey);
  if (state.status === "error") {
    // Counting from an empty map would reset every streak and clear every
    // latch: skip this run's bookkeeping; the next run counts from the stored state.
    console.error(`[feed-health] ${config.stateKey} unreadable, this run is not counted`);
    return;
  }
  const prev = state.status === "hit" ? state.value : {};
  const next: HealthMap = {};
  const newlyFailing: { outcome: FeedOutcome; runs: number }[] = [];
  const recovered: FeedOutcome[] = [];

  for (const o of outcomes) {
    const before = prev[o.id] ?? { consecutiveFailures: 0, alerted: false };
    if (o.skipped) {
      next[o.id] = before;
      continue;
    }
    if (o.ok) {
      if (before.alerted) recovered.push(o);
      next[o.id] = { consecutiveFailures: 0, alerted: false };
    } else {
      const count = before.consecutiveFailures + 1;
      const crossing = count >= config.failThreshold && !before.alerted;
      if (crossing) newlyFailing.push({ outcome: o, runs: count });
      // Latched once the alert goes out, cleared only on recovery.
      next[o.id] = { consecutiveFailures: count, alerted: before.alerted || crossing };
    }
  }

  if (newlyFailing.length > 0) {
    const body = newlyFailing
      .map(({ outcome, runs }) => {
        const todo = config.action?.(outcome);
        return todo ? `${line(outcome, runs)}\n  What to do: ${todo}` : line(outcome, runs);
      })
      .join("\n");
    const text = `No usable output for ${config.failThreshold}+ consecutive runs (${config.downWindow}):\n${body}`;
    const sent = config.page ? await sendPage("problem", config.downTitle, text) : await sendAlert("error", config.downTitle, text);
    // Not delivered: leave the latch open so the next failing run tries again.
    if (!sent) for (const { outcome } of newlyFailing) next[outcome.id] = { ...next[outcome.id], alerted: false };
  }
  if (recovered.length > 0) {
    const text = recovered.map((o) => line(o)).join("\n");
    const sent = config.page
      ? await sendPage("resolved", config.recoveredTitle, text)
      : await sendAlert("success", config.recoveredTitle, text);
    // Keep the latch so the next healthy run sends the recovery again.
    if (!sent) for (const o of recovered) next[o.id] = { ...next[o.id], alerted: true };
  }

  await setCached(config.stateKey, next, { source: config.cacheSource });
}
