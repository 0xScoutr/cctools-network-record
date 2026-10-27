/**
 * A hook called once per upstream request, before it is sent, for whoever
 * counts calls per provider and endpoint. No-op by default.
 */

export type UsageTracker = (provider: string, endpoint: string) => void;

let tracker: UsageTracker = () => {};

/** Replace the tracker; returns the previous one. */
export function setUsageTracker(next: UsageTracker): UsageTracker {
  const previous = tracker;
  tracker = next;
  return previous;
}

export function trackApiUsage(provider: string, endpoint: string): void {
  try {
    tracker(provider, endpoint);
  } catch {
    /* counting never breaks a call */
  }
}
