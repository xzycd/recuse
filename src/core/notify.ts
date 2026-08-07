/**
 * Getting an event off this machine.
 *
 * One sink: an HTTP POST of the event as JSON. There is deliberately no
 * `--exec`, no shell hook and no spawned process, because `recuse watch --json`
 * already emits one event per line on stdout and
 *
 *   recuse watch --json | while read -r e; do notify-send "$e"; done
 *
 * gives anyone the same power without this program ever touching
 * `child_process`. SECURITY.md claims the tool spawns nothing. Keeping that
 * true is worth more than a convenience flag.
 *
 * Telegram, Discord and Slack all accept a JSON POST, so the one sink covers
 * the three places anyone actually wants these.
 */

import { redactMessage, safeEndpoint } from './safe.js';
import type { WatchEvent } from './watch.js';

const TIMEOUT_MS = 8_000;

export interface Delivery {
  ok: boolean;
  /** Why it failed, with any credential in the URL already removed. */
  reason?: string;
}

/**
 * Check a webhook URL before the daemon starts rather than on first event.
 *
 * A watcher that runs all night and only discovers its webhook is malformed
 * when something finally happens has failed at the one job it had.
 */
export function checkWebhook(url: string): void {
  safeEndpoint(url);
}

/**
 * POST one event.
 *
 * Never throws. A webhook that is down is not a reason to stop watching, and
 * the event is already on stdout and in the log by the time this runs.
 */
export async function deliver(url: string, event: WatchEvent): Promise<Delivery> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
      signal: controller.signal,
    });

    if (!res.ok) return { ok: false, reason: `webhook answered ${res.status}` };
    return { ok: true };
  } catch (err) {
    // A Telegram webhook carries a bot token in its path. Node puts request
    // URLs into some network error messages, and this one is printed.
    return { ok: false, reason: redactMessage((err as Error).message ?? String(err)) };
  } finally {
    clearTimeout(timer);
  }
}
