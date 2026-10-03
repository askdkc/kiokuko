import { createHash } from 'node:crypto';
/** Only observed polling events change connection state; logging severity is separate. */
export type PollState = 'starting' | 'operational' | 'degraded' | 'unknown' | 'stopped';
export interface DiagnosticEvent { time: number; level: 'DEBUG' | 'INFO' | 'WARN'; kind: string; failures: number; category: string | null }
export class PollDiagnostics {
  state: PollState = 'starting';
  failures = 0;
  category: string | null = null;
  lastSuccess: number | null = null;
  lastFailure: number | null = null;
  retryInMs: number | null = null;
  deadlineMs: number | null = null;
  requestId: string | null = null;
  attempt = 0;
  durationMs: number | null = null;
  events: DiagnosticEvent[] = [];
  #transientFailures = 0;
  #start: number | null = null;
  #warned = false;
  #lastWarning = -Infinity;
  #immediate = new Map<string, number>();
  #lastMetrics = 0;
  record(time: number, level: DiagnosticEvent['level'], kind: string): DiagnosticEvent {
    const event = { time, level, kind, failures: this.failures, category: this.category };
    this.events.push(event); if (this.events.length > 200) this.events.shift();
    return event;
  }
  unknown(time: number): DiagnosticEvent | undefined {
    if (this.state === 'stopped') return;
    const changed = this.state !== 'unknown'; this.state = 'unknown';
    return changed ? this.record(time, 'WARN', 'diagnostics_unavailable') : undefined;
  }
  success(time: number): DiagnosticEvent | undefined {
    if (this.state === 'stopped' || (this.lastFailure !== null && time <= this.lastFailure)) return;
    const recovery = this.failures > 0;
    this.lastSuccess = time; this.state = 'operational'; this.failures = 0; this.retryInMs = null;
    const event = recovery ? this.record(time, this.#warned ? 'INFO' : 'DEBUG', 'poll_recovered') : undefined;
    this.#warned = false; this.#transientFailures = 0; this.#lastWarning = -Infinity; this.#immediate.clear(); this.category = null;
    return event;
  }
  metrics(timestampSeconds: number): DiagnosticEvent | undefined {
    const timestamp = timestampSeconds * 1000;
    if (!Number.isFinite(timestamp) || timestamp <= this.#lastMetrics) return;
    this.#lastMetrics = timestamp;
    return this.success(timestamp);
  }
  line(raw: string, receivedAt: number, monotonicAt = receivedAt): DiagnosticEvent | undefined {
    if (this.state === 'stopped') return;
    let value: Record<string, unknown>;
    try { value = JSON.parse(raw); } catch { return this.unknown(receivedAt); }
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.msg !== 'string' || typeof value.level !== 'string') return this.unknown(receivedAt);
    const parsed = typeof value.time === 'string' ? Date.parse(value.time) : NaN;
    const time = Number.isFinite(parsed) ? parsed : receivedAt;
    if (value.component !== 'controlplane') {
      return ['WARN', 'ERROR'].includes(value.level) ? this.record(time, 'WARN', 'upstream_error') : undefined;
    }
    if (value.msg === 'poll cycle started') { this.attempt++; this.#start = time; return; }
    if (value.msg === 'poll cycle complete' || value.msg === 'poller recovered; polling operational') {
      this.durationMs = this.#start !== null && time >= this.#start ? time - this.#start : null;
      this.#start = null; return this.success(time);
    }
    if (value.msg !== 'poll timed out; backing off' && value.msg !== 'poll failed; backing off') {
      return ['WARN', 'ERROR'].includes(value.level) ? this.unknown(time) : undefined;
    }
    if (typeof value.error !== 'string') return this.unknown(time);
    const error = value.error;
    const status = typeof value.status_code === 'number' && Number.isInteger(value.status_code) && value.status_code >= 100 && value.status_code <= 599 ? value.status_code : null;
    let category = 'unknown';
    if (status !== null) category = `http_${status}`;
    else if (/x509:|certificate|tls:/i.test(error)) category = 'certificate';
    else if (/invalid character|unmarshal|decode|malformed|unexpected end of JSON/i.test(error)) category = 'malformed_response';
    else if (value.msg === 'poll timed out; backing off' && /deadline exceeded|Client.Timeout|i\/o timeout/i.test(error)) category = 'timeout';
    else if (/connection reset by peer|connection refused|network is unreachable|no route to host|unexpected EOF|: EOF$/i.test(error)) category = 'network';
    this.failures++; this.lastFailure = time; this.state = 'degraded'; this.category = category;
    this.durationMs = this.#start !== null && time >= this.#start ? time - this.#start : null; this.#start = null;
    const number = (x: unknown) => typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : null;
    this.retryInMs = number(value.retry_in_ms); this.deadlineMs = number(value.poll_deadline_ms);
    this.requestId = typeof value.tunnel_request_id === 'string' && /^req_[a-zA-Z0-9_-]{1,128}$/.test(value.tunnel_request_id) ? value.tunnel_request_id : null;
    const transient = category === 'network' || category === 'timeout';
    this.#transientFailures = transient ? this.#transientFailures + 1 : 0;
    const key = transient ? category : category + ':' + createHash('sha256').update(error).digest('hex');
    const last = transient ? this.#lastWarning : this.#immediate.get(key) ?? -Infinity;
    const warn = (!transient || this.#transientFailures >= 3) && monotonicAt - last >= 60_000;
    if (warn) { this.#warned = true; this.#lastWarning = monotonicAt; if (this.#immediate.size >= 32) this.#immediate.clear(); this.#immediate.set(key, monotonicAt); }
    return this.record(time, warn ? 'WARN' : 'DEBUG', 'poll_failed');
  }
}
