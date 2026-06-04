import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { errorMessage } from './errors.js';
import {
  readLastReport,
  resultsFileStatus,
  type PwReport,
  type ResultsPathConfig,
  type ResultsFileStatus,
} from './results.js';

const MAX_ACTIVE_RUNS = 4;
const MAX_TRACKED_RUNS = 50;
const KILL_ESCALATION_MS = 5_000;
const PROGRESS_CARRY_LIMIT = 64;

type TrackedRunState = 'running' | 'completed' | 'failed' | 'timedOut';

interface RunProgress {
  current: number | null;
  total: number | null;
}

interface TrackedRun {
  id: string;
  cwd: string;
  cmd: string[];
  pid: number | null;
  state: TrackedRunState;
  startedAt: string;
  startedAtMs: number;
  completedAt: string | null;
  timeoutMs: number;
  progress: RunProgress;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  error: string | null;
  resultsFile: ResultsFileStatus | null;
  reportStats: PwReport['stats'] | null;
  liveStatsMtimeMs: number | null;
  liveStats: PwReport['stats'] | null;
}

function nextStableRunId(): string {
  return `run-${randomUUID()}`;
}

function emptyProgress(): RunProgress {
  return { current: null, total: null };
}

function parseProgress(text: string): RunProgress | null {
  const matches = Array.from(text.matchAll(/\[(\d+)\/(\d+)\]/g));
  const last = matches.at(-1);
  if (!last) return null;
  return { current: Number(last[1]), total: Number(last[2]) };
}

function applyProgress(run: TrackedRun, chunk: unknown) {
  const parsed = parseProgress(String(chunk));
  if (parsed) run.progress = parsed;
}

function terminalProgressFromStats(stats: PwReport['stats'] | null): RunProgress | null {
  if (!stats) return null;
  const total = stats.expected + stats.unexpected + (stats.flaky ?? 0) + stats.skipped;
  return { current: total, total };
}

function signalProcessTree(child: ReturnType<typeof spawn>, signal: NodeJS.Signals) {
  if (child.pid && process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to signaling the direct child when process-group signaling is unavailable.
    }
  }
  child.kill(signal);
}

export class RunTracker {
  private readonly runs = new Map<string, TrackedRun>();

  constructor(private readonly config: ResultsPathConfig) {}

  private startRunError(cwd: string): string | null {
    const active = this.activeRuns();
    const activeForDir = active.find((run) => run.cwd === cwd);
    if (activeForDir) {
      return (
        `A Playwright run is already running for workingDirectory "${cwd}" ` +
        `(runId: ${activeForDir.id}). Poll get_run_status before starting another run there.`
      );
    }

    const activeCount = active.length;
    if (activeCount >= MAX_ACTIVE_RUNS) {
      return (
        `Too many active Playwright runs (${activeCount}). ` +
        `Wait for one to finish before starting another tracked run.`
      );
    }

    return null;
  }

  startTrackedRun(
    cmd: string[],
    cwd: string,
    timeoutMs: number
  ): { run: TrackedRun } | { error: string } {
    const startError = this.startRunError(cwd);
    if (startError) return { error: startError };

    const now = Date.now();
    const run: TrackedRun = {
      id: nextStableRunId(),
      cwd,
      cmd,
      pid: null,
      state: 'running',
      startedAt: new Date(now).toISOString(),
      startedAtMs: now,
      completedAt: null,
      timeoutMs,
      progress: emptyProgress(),
      exitCode: null,
      signal: null,
      error: null,
      resultsFile: null,
      reportStats: null,
      liveStatsMtimeMs: null,
      liveStats: null,
    };
    this.runs.set(run.id, run);
    this.evictOldTrackedRuns();

    let settled = false;
    let timedOut = false;
    let child: ReturnType<typeof spawn>;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    let killEscalationHandle: ReturnType<typeof setTimeout> | null = null;
    let stdoutProgressCarry = '';

    const complete = () => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (killEscalationHandle && (!timedOut || process.platform === 'win32'))
        clearTimeout(killEscalationHandle);
      run.completedAt = new Date().toISOString();
      this.evictOldTrackedRuns();
    };

    try {
      child = spawn(cmd[0], cmd.slice(1), {
        cwd,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      run.state = 'failed';
      run.error = `Failed to spawn Playwright: ${errorMessage(e)}`;
      this.captureRunReport(run);
      complete();
      return { run };
    }

    run.pid = child.pid ?? null;
    child.stdout?.on('data', (chunk) => {
      const text = stdoutProgressCarry + String(chunk);
      applyProgress(run, text);
      stdoutProgressCarry = text.slice(-PROGRESS_CARRY_LIMIT);
    });
    child.stderr?.resume();
    child.once('error', (e) => {
      if (timedOut) {
        run.state = 'timedOut';
      } else {
        run.state = 'failed';
        run.error = `Failed to spawn Playwright: ${errorMessage(e)}`;
      }
      this.captureRunReport(run);
      complete();
    });
    child.once('close', (code, signal) => {
      if (!settled) {
        run.exitCode = code;
        if (signal !== null) run.signal = signal;
      }
      if (!settled) {
        run.state = timedOut ? 'timedOut' : code === 0 ? 'completed' : 'failed';
      }
      if (!settled) this.captureRunReport(run);
      complete();
    });

    timeoutHandle = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      run.error = `Playwright test run exceeded the ${timeoutMs}ms timeout and was killed.`;
      signalProcessTree(child, 'SIGTERM');
      if (settled) return;
      killEscalationHandle = setTimeout(() => {
        if (!timedOut) return;
        if (!settled) run.signal = 'SIGKILL';
        signalProcessTree(child, 'SIGKILL');
      }, KILL_ESCALATION_MS);
      killEscalationHandle.unref?.();
    }, timeoutMs);

    return { run };
  }

  runStatus(run: TrackedRun) {
    const resultsFile = run.resultsFile ?? resultsFileStatus(this.config, run.cwd, run.startedAtMs);
    const endedAtMs = run.completedAt ? Date.parse(run.completedAt) : Date.now();
    const stats =
      run.reportStats ?? (run.state === 'running' ? this.liveStatsForRun(run, resultsFile) : null);

    return {
      runId: run.id,
      state: run.state,
      tracking: true,
      pid: run.pid,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      elapsedMs: Math.max(0, endedAtMs - run.startedAtMs),
      timeoutMs: run.timeoutMs,
      command: {
        executable: run.cmd[0],
        args: run.cmd.slice(1),
        cwd: run.cwd,
      },
      progress:
        run.completedAt === null
          ? run.progress
          : (terminalProgressFromStats(stats) ?? run.progress),
      exitCode: run.exitCode,
      signal: run.signal,
      error: run.error,
      resultsFile,
      stats,
    };
  }

  private liveStatsForRun(
    run: TrackedRun,
    resultsFile: ResultsFileStatus
  ): PwReport['stats'] | null {
    if (!resultsFile.updatedAfterStart || resultsFile.mtimeMs === null) return null;

    if (run.liveStatsMtimeMs === resultsFile.mtimeMs) return run.liveStats;

    run.liveStatsMtimeMs = resultsFile.mtimeMs;
    run.liveStats = readLastReport(this.config, run.cwd)?.stats ?? null;
    return run.liveStats;
  }

  idleStatus(cwd: string) {
    return {
      runId: null,
      state: 'idle' as const,
      tracking: false,
      pid: null,
      startedAt: null,
      completedAt: null,
      elapsedMs: 0,
      timeoutMs: null,
      command: null,
      progress: emptyProgress(),
      exitCode: null,
      signal: null,
      error: null,
      resultsFile: resultsFileStatus(this.config, cwd),
      stats: readLastReport(this.config, cwd)?.stats ?? null,
    };
  }

  latestRunForDir(cwd: string): TrackedRun | null {
    let latest: TrackedRun | null = null;
    for (const run of this.runs.values()) {
      if (run.cwd !== cwd) continue;
      latest = run;
    }
    return latest;
  }

  getRun(runId: string): TrackedRun | null {
    return this.runs.get(runId) ?? null;
  }

  private activeRuns(): TrackedRun[] {
    return Array.from(this.runs.values()).filter((run) => run.completedAt === null);
  }

  private evictOldTrackedRuns() {
    for (const run of this.runs.values()) {
      if (this.runs.size <= MAX_TRACKED_RUNS) return;
      if (run.completedAt !== null) this.runs.delete(run.id);
    }
  }

  private captureRunReport(run: TrackedRun) {
    run.resultsFile = resultsFileStatus(this.config, run.cwd, run.startedAtMs);
    run.reportStats = run.resultsFile.updatedAfterStart
      ? (readLastReport(this.config, run.cwd)?.stats ?? null)
      : null;
  }
}
