/**
 * The snapshot series of day D come from the one ACS snapshot at
 * D+1 00:00:00Z. Forward collection reads it once a day from 00:15 UTC; the
 * backfill reads the same thing for past days, so both share one method.
 */

import { CURSOR_SNAPSHOT, METHOD_SCAN, addDays, endOfDay, utcDate } from "../open-record/contract";
import { TEMPLATES, extractSnapshot, isTemplate, type AcsCreatedEvent } from "./acs";
import { ScanBusyError, scanSlotMaxWaitMs, scanSpacingMs, type ScanCallClass } from "./scan-budget";
import { SCAN_TIMEOUT_MS, scanCallWorstCaseMs, type ScanApi } from "./scan-client";
import type { CursorRow, RecordStore, SnapshotRow } from "./store";

/** The D+1 00:00Z snapshot is first tried this long after midnight. */
export const SNAPSHOT_AFTER_MINUTES = 15;

/** From this long after midnight a day with no stored row is starved: a wait that pages. */
export const SNAPSHOT_STARVED_AFTER_MINUTES = 4 * 60;

/**
 * The time `calls` ACS calls in a row need before a deadline, in the model the
 * Scan client checks every call by: a call is refused as busy when the time it
 * is asked plus its class's worst case (scanCallWorstCaseMs: slot wait plus
 * timeout) passes the deadline, and each later call is asked when the one
 * before it returns. So the last call passes its check when it is asked by
 * the deadline less that worst case, and it is asked after:
 *   - the first call's slot, at most scanSlotMaxWaitMs(cls) after now;
 *   - each later slot but the last one's, one step after the slot before: the
 *     shared queue starts a call no sooner than the spacing after the previous
 *     start and never before the previous answer, which ends within the
 *     timeout, so a step is at most max(spacing, timeout);
 *   - the answer before the last call, within the timeout.
 * The step holds while no other record or backfill call takes a slot between
 * the read's own calls. One that does (the backfill, 02:00 to 06:00 UTC, only
 * when the day was not read at 00:15) can still leave a later call refused as
 * busy: it stores nothing and counts no attempt. Allowing for it here would
 * need 320 s for the record class, more than the collector's lock leaves.
 */
function acsReadHeadroomMs(cls: ScanCallClass, calls: number): number {
  const step = Math.max(scanSpacingMs(), SCAN_TIMEOUT_MS);
  return scanSlotMaxWaitMs(cls) + (calls - 2) * step + SCAN_TIMEOUT_MS + scanCallWorstCaseMs(cls);
}

/**
 * The time the four core templates need before a deadline (acsReadHeadroomMs):
 * 260 s for the record class, 380 s for the backfill. readSnapshot refuses as
 * busy, before its first call, when now plus this passes its deadline, so a
 * late run spends no call instead of spending DsoRules and failing busy
 * halfway. The collector can use it to end its other reads in time to leave
 * the snapshot this much.
 */
export function snapshotCoreHeadroomMs(cls: ScanCallClass = "record"): number {
  return acsReadHeadroomMs(cls, 4);
}

/**
 * The time one ValidatorLicense read (up to two pages on MainNet) needs before
 * a deadline, in the model of acsReadHeadroomMs: 320 s for the backfill class.
 * The backfill's license completion pass starts a read only while this fits.
 */
export function licenseReadHeadroomMs(cls: ScanCallClass = "backfill"): number {
  return acsReadHeadroomMs(cls, 2);
}

/**
 * After a failed attempt (a busy budget is not one) the stage spends no calls
 * on the same day for `backoffMs`, and stops after `maxAttempts`. Eight
 * attempts half an hour apart cover about four hours from 00:15, past a
 * snapshot Scan serves late; a failure that outlasts them is an outage to page
 * (gave_up), not a reason to spend the shared record queue all day. The
 * backfill repairs the core series of a day the forward stage missed.
 */
export const SNAPSHOT_RETRY = { backoffMs: 30 * 60_000, maxAttempts: 8 } as const;

/**
 * The day the stage works on at `nowMs`: yesterday in UTC. It is the only
 * reader of ValidatorLicense, so once this is past a day, that day's count is
 * never read again (finalize passes it as DayInputs.snapshotStageDate).
 */
export function snapshotStageDate(nowMs: number): string {
  return addDays(utcDate(nowMs), -1);
}

type SnapshotRetry = {
  attempts: number;
  next_try_at: string;
  last_error: string;
};

type AcsAnswer = { host: string; events: AcsCreatedEvent[] };

const NONE: AcsCreatedEvent[] = [];

/** extractSnapshot over the templates read so far, so a hole is found before the next call is spent. */
function extractPart(part: Partial<Parameters<typeof extractSnapshot>[0]>) {
  return extractSnapshot({
    dsoRules: NONE,
    openRounds: NONE,
    issuingRounds: NONE,
    featuredApps: NONE,
    validatorLicenses: null,
    ...part,
  });
}

const shortName = (template: string) => template.slice(template.lastIndexOf(":") + 1);

/**
 * The answer, once every event in it is of the template asked for. An event
 * of another template means the host ignored the filter or the template id
 * changed shape: extractSnapshot would drop it without a word, so a count read
 * from that answer could be short (0 in the worst case) and is refused.
 */
function ofTemplate(answer: AcsAnswer, template: string, recordTime: string): AcsAnswer {
  const foreign = answer.events.filter((e) => !isTemplate(e, template)).length;
  if (foreign > 0) {
    throw new Error(
      `snapshot at ${recordTime} is not usable: ${foreign} of ${answer.events.length} ${shortName(template)} ` +
        "events carry another template id",
    );
  }
  return answer;
}

/**
 * `deadline` (epoch ms) is the time by which every call must have ended; a
 * call whose worst case would pass it is refused as busy before it is made.
 * The first call is held to the whole read (acsReadHeadroomMs in the ScanApi's
 * class: snapshotCoreHeadroomMs, or one call more with licenses): it is asked
 * with the deadline less the part after its own worst case, so the ScanApi,
 * which knows its own clock, refuses it unless the last call's check will pass.
 */
export async function readSnapshot(
  scan: ScanApi,
  migrationId: number,
  date: string,
  opts: { withLicenses: boolean; deadline?: number },
): Promise<SnapshotRow> {
  const recordTime = endOfDay(date);
  const incomplete = (template: string) => new Error(`snapshot at ${recordTime} is incomplete: no ${template}`);
  const ask = async (template: string, host?: string, deadline = opts.deadline) =>
    ofTemplate(await scan.acsSnapshot(migrationId, recordTime, template, host, deadline), template, recordTime);

  // Each template is checked right after its own call, so a read that cannot
  // succeed (a second DsoRules, a shape change) spends one to four calls of
  // the shared queue instead of all of them.
  const tail = acsReadHeadroomMs(scan.cls, opts.withLicenses ? 5 : 4) - scanCallWorstCaseMs(scan.cls);
  const dso = await ask(TEMPLATES.dsoRules, undefined, opts.deadline === undefined ? undefined : opts.deadline - tail);
  // Exactly one DsoRules with members: without members the count is 0 and
  // there is no threshold, a hole too.
  const members = extractPart({ dsoRules: dso.events });
  if (members.superValidators == null || members.svVotingThreshold == null) throw incomplete("DsoRules");

  // The row names one source host. The later templates ask only
  // the host that answered DsoRules, so a throttled host reports busy (a wait,
  // retried next run) instead of the Scan client falling back mid-snapshot.
  const read = (template: string) => ask(template, dso.host);
  const open = await read(TEMPLATES.openRound);
  if (extractPart({ openRounds: open.events }).referencePriceUsd == null) throw incomplete("OpenMiningRound");
  const issuing = await read(TEMPLATES.issuingRound);
  if (extractPart({ issuingRounds: issuing.events }).lastRound == null) throw incomplete("IssuingMiningRound");
  // MainNet always has featured apps and validator licenses: an empty answer
  // is a hole, never a measured 0.
  const featured = await read(TEMPLATES.featuredApp);
  if (extractPart({ featuredApps: featured.events }).featuredApps === 0) throw incomplete("FeaturedAppRight");
  const licenses = opts.withLicenses ? await read(TEMPLATES.validatorLicense) : null;
  if (licenses && !extractPart({ validatorLicenses: licenses.events }).validatorLicenses) {
    throw incomplete("ValidatorLicense");
  }

  // Backstop for a ScanApi that does not honour the pin: a template credited
  // to the wrong Scan is refused, never stored.
  const hosts = [...new Set([dso, open, issuing, featured, licenses].flatMap((r) => (r ? [r.host] : [])))];
  if (hosts.length > 1) throw new Error(`snapshot at ${recordTime} was read from more than one host: ${hosts.join(", ")}`);

  const x = extractSnapshot({
    dsoRules: dso.events,
    openRounds: open.events,
    issuingRounds: issuing.events,
    featuredApps: featured.events,
    validatorLicenses: licenses?.events ?? null,
  });
  return {
    date,
    record_time: recordTime,
    migration_id: migrationId,
    source_host: dso.host,
    method: METHOD_SCAN,
    last_round: x.lastRound,
    reference_round: x.referenceRound,
    reference_price_usd: x.referencePriceUsd,
    super_validators: x.superValidators,
    sv_voting_threshold: x.svVotingThreshold,
    featured_apps: x.featuredApps,
    validator_licenses: x.validatorLicenses,
  };
}

/**
 * The ValidatorLicense count of a stored snapshot, from the same host,
 * migration and record time as the rest of its row: one template (one or two
 * pages on MainNet) instead of a full re-read.
 */
export async function readLicenseCount(scan: ScanApi, row: SnapshotRow, deadline: number): Promise<number> {
  const recordTime = endOfDay(row.date);
  const template = TEMPLATES.validatorLicense;
  const r = ofTemplate(
    await scan.acsSnapshot(row.migration_id, recordTime, template, row.source_host, deadline),
    template,
    recordTime,
  );
  if (r.host !== row.source_host) {
    throw new Error(`validator licenses at ${recordTime} came from ${r.host}, not the row's ${row.source_host}`);
  }
  const count = extractPart({ validatorLicenses: r.events }).validatorLicenses;
  if (!count) throw new Error(`snapshot at ${recordTime} is incomplete: no ValidatorLicense`);
  return count;
}

export interface SnapshotStageResult {
  date: string;
  /**
   * not_due   before 00:15 UTC.
   * already   the day's row is stored with every series.
   * written   stored this run, or its missing licenses added.
   * failed    this run spent calls and failed; the next try is SNAPSHOT_RETRY.backoffMs later.
   * waiting   an earlier attempt failed and the next is not due: no calls this run.
   * gave_up   SNAPSHOT_RETRY.maxAttempts attempts failed and the day has no row: no
   *           more calls for this date.
   * licenses_gave_up
   *           the core row is stored and SNAPSHOT_RETRY.maxAttempts reads of
   *           its ValidatorLicense count failed: no more calls for this date,
   *           and the day's count stays null.
   * starved   the day still has no row from 04:00 UTC (SNAPSHOT_STARVED_AFTER_MINUTES)
   *           and this run could not read it: the budget was busy (no attempt
   *           counted) or a backoff is running.
   *
   * failed, waiting, gave_up and starved all mean the day's snapshot is still
   * missing, or its license count when a core row is stored. snapshotStageHealth
   * says how a caller counts each.
   */
  state: "not_due" | "already" | "written" | "failed" | "waiting" | "gave_up" | "licenses_gave_up" | "starved";
  detail?: string;
}

export type SnapshotHealth = "healthy" | "failing" | "neutral";

/**
 * How a caller's health counts a stage result. failed and gave_up are failing:
 * the collector's run is not ok while the stage says so, whatever the rest of
 * the run did. starved is failing too, so a snapshot the shared queue keeps
 * starving pages instead of waiting unseen. waiting is neutral, a backoff
 * after a failure already counted: neither a recovery (it must not reset a
 * failure streak) nor another failure. licenses_gave_up is neutral for the
 * same reason: each of its failed license reads was a failing run, so the
 * loss is already counted on the snapshot's latch (at most one page for the
 * day), which it holds as it stands until the next day's stage; the day's
 * core series are stored, so the rest of the day's runs are not failures.
 * The rest are healthy.
 */
export function snapshotStageHealth(result: SnapshotStageResult): SnapshotHealth {
  switch (result.state) {
    case "failed":
    case "gave_up":
    case "starved":
      return "failing";
    case "waiting":
    case "licenses_gave_up":
      return "neutral";
    case "not_due":
    case "already":
    case "written":
      return "healthy";
  }
}

/** The failed attempts recorded for `date`, or null when there are none (or they belong to another day). */
function retryFor(cursor: CursorRow | null, date: string): SnapshotRetry | null {
  const d = cursor?.detail as Partial<SnapshotRetry> | undefined;
  if (cursor?.last_date !== date || typeof d?.attempts !== "number" || typeof d.next_try_at !== "string") return null;
  return { attempts: d.attempts, next_try_at: d.next_try_at, last_error: String(d.last_error ?? "") };
}

/** Record the failed attempts of `date` on CURSOR_SNAPSHOT, or with null clear them. */
async function saveRetry(store: RecordStore, date: string, now: Date, retry: SnapshotRetry | null): Promise<void> {
  await store.setCursor({
    id: CURSOR_SNAPSHOT,
    last_round: null,
    last_date: date,
    last_poll_at: now.toISOString(),
    detail: retry ?? {},
  });
}

/**
 * The collector's daily stage: from 00:15 UTC, read yesterday's snapshot.
 * A busy budget (a closed gate, a long queue, or `deadline` too close) is
 * thrown to the caller: it is a wait, not a failure, and costs no attempt.
 * From 04:00 UTC, while the day has no row, it is returned as starved instead
 * (still no attempt), and so is a running backoff, so the caller pages.
 * Any other error is an attempt, recorded on CURSOR_SNAPSHOT, and the day is
 * not read again until SNAPSHOT_RETRY.backoffMs has passed.
 *
 * The four core templates are stored first and the ValidatorLicense count is
 * added afterwards, so a failed license read never costs the core series.
 * The same path completes a row stored without licenses by the backfill (it
 * does not read ValidatorLicense, and its write leaves a stored count alone)
 * when the forward read had not landed by 02:00.
 *
 * `deadline` (epoch ms) is the time by which every Scan call of the stage must
 * have ended. It is required: the collector passes its lock expiry less a
 * margin, so calls spaced 30 s apart in the shared queue cannot run past the
 * lock and overlap the next run.
 */
export async function runSnapshotStage(deps: {
  store: RecordStore;
  scan: ScanApi;
  migrationId: number;
  now: Date;
  deadline: number;
}): Promise<SnapshotStageResult> {
  const { store, scan, now, deadline } = deps;
  const today = utcDate(now.getTime());
  const date = snapshotStageDate(now.getTime());
  const dueAt = Date.parse(`${today}T00:00:00Z`) + SNAPSHOT_AFTER_MINUTES * 60_000;
  if (now.getTime() < dueAt) return { date, state: "not_due" };
  let stored = await store.getSnapshot(date);
  if (stored && stored.validator_licenses != null) return { date, state: "already" };
  const starvedAt = Date.parse(`${today}T00:00:00Z`) + SNAPSHOT_STARVED_AFTER_MINUTES * 60_000;
  const starved = !stored && now.getTime() >= starvedAt;
  const starvedDetail = (why: string) => `still no snapshot for ${date} after ${new Date(starvedAt).toISOString()}: ${why}`;

  const cursor = await store.getCursor(CURSOR_SNAPSHOT);
  const retry = retryFor(cursor, date);
  if (retry && retry.attempts >= SNAPSHOT_RETRY.maxAttempts) {
    const detail = `gave up after ${retry.attempts} failed attempts: ${retry.last_error}`;
    // A stored row got here without its count: only the license reads failed.
    return { date, state: stored ? "licenses_gave_up" : "gave_up", detail };
  }
  if (retry && now.getTime() < Date.parse(retry.next_try_at)) {
    const detail = `attempt ${retry.attempts} failed (${retry.last_error}); next try at ${retry.next_try_at}`;
    return starved ? { date, state: "starved", detail: starvedDetail(detail) } : { date, state: "waiting", detail };
  }

  let result: SnapshotStageResult;
  let coreStored = false;
  try {
    if (!stored) {
      stored = await readSnapshot(scan, deps.migrationId, date, { withLicenses: false, deadline });
      await store.upsertSnapshot(stored);
      coreStored = true;
    }
    const validatorLicenses = await readLicenseCount(scan, stored, deadline);
    await store.upsertSnapshot({ ...stored, validator_licenses: validatorLicenses });
    result = coreStored
      ? { date, state: "written" }
      : { date, state: "written", detail: "added validator licenses to a row stored without them" };
  } catch (err) {
    if (err instanceof ScanBusyError) {
      // Busy in the core read, so the day still has no row.
      if (starved && !coreStored) return { date, state: "starved", detail: starvedDetail(err.message) };
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    const attempts = (retry?.attempts ?? 0) + 1;
    const nextTryAt = new Date(now.getTime() + SNAPSHOT_RETRY.backoffMs).toISOString();
    try {
      await saveRetry(store, date, now, { attempts, next_try_at: nextTryAt, last_error: message.slice(0, 300) });
    } catch (storeErr) {
      // Neither error may hide the other: the read failure is the cause, the store failure is why it is not recorded.
      const storeMessage = storeErr instanceof Error ? storeErr.message : String(storeErr);
      throw new Error(`snapshot for ${date} failed (${message}) and the attempt could not be recorded: ${storeMessage}`);
    }
    const detail = coreStored ? `stored without validator licenses: ${message}` : message;
    return { date, state: "failed", detail: `${detail} (attempt ${attempts} of ${SNAPSHOT_RETRY.maxAttempts})` };
  }
  // Outside the try: a failed clean-up write must not be counted as a failed read.
  if (cursor && Object.keys(cursor.detail ?? {}).length > 0) await saveRetry(store, date, now, null);
  return result;
}
