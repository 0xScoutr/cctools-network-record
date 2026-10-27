/**
 * Where the record's alarms go. An alert goes to the operator's summary; a
 * page asks for attention now. Both answer false when the message was not
 * delivered, so a caller can keep its latch open and try again.
 *
 * The default sink writes to the console and answers true. A deployment plugs
 * in its own channel (setAlertSink).
 */

export type AlertSeverity = "error" | "warning" | "info" | "success" | "problem" | "resolved";

export interface AlertSink {
  send(message: { severity: AlertSeverity; title: string; text: string; page: boolean }): Promise<boolean>;
}

export const consoleAlertSink: AlertSink = {
  async send({ severity, title, text, page }) {
    console.warn(`[alert${page ? ":page" : ""}] ${severity}: ${title}\n${text}`);
    return true;
  },
};

let sink: AlertSink = consoleAlertSink;

/** Replace the sink; returns the previous one. */
export function setAlertSink(next: AlertSink): AlertSink {
  const previous = sink;
  sink = next;
  return previous;
}

async function deliver(severity: AlertSeverity, title: string, text: string, page: boolean): Promise<boolean> {
  try {
    return await sink.send({ severity, title, text, page });
  } catch (err) {
    console.error(`[alerts] ${title} not delivered:`, err instanceof Error ? err.message : err);
    return false;
  }
}

/** An alert for the operator's summary. Never throws. */
export function sendAlert(severity: AlertSeverity, title: string, text: string): Promise<boolean> {
  return deliver(severity, title, text, false);
}

/** A page: needs attention now. Never throws. */
export function sendPage(severity: AlertSeverity, title: string, text: string): Promise<boolean> {
  return deliver(severity, title, text, true);
}
