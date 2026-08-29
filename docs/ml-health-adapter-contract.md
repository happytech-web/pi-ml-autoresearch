# ML Health Adapter Contract

The bundled `ml-health-adapter.py` is a conservative file-to-`HealthInput` mapper. It is not a
Slurm, tmux, multi-rank, GPU, or checkpoint detector. Each project must provide a small adapter that
collects those signals on the final training host and emits the declared JSON input before the
sentinel probe.

## Required identity

Every output must include the exact `campaignId`, `runId`, and `attemptId` from the approved campaign.
The adapter must not select a different run because it is newer, has a better metric, or happens to
be the only process alive. A mismatch is evidence of `unknown` or `failed`, never a reason to switch
the monitor to another trial.

For an executor process, emit both booleans:

```json
{
  "executor": {
    "processAlive": true,
    "identityMatches": true
  }
}
```

`identityMatches` must bind at least the PID start identity, command/argv, working directory or
campaign path, and the executor's recorded run token. A PID by itself is not sufficient. If a
terminal campaign intentionally has no executor process, the adapter may emit
`"expectedStopped": true` only when an independently verified terminal record proves that all
training ranks exited and the artifact/reconcile gates passed.

## Signal mapping

| Source | Adapter evidence | Failure behavior |
|---|---|---|
| tmux/pidfile or executor state | executor PID, start time, argv, campaign path | missing, reused, or mismatched identity becomes unavailable/failed |
| Slurm `squeue`/`sacct` | job ID, state, exit code, step/rank count | stale job ID or ambiguous state is unknown; never infer success from `PENDING` |
| launcher/rank manifest | expected rank IDs and exit status | missing rank or early exit is failed; all-ranks-exited requires explicit evidence |
| progress/checkpoint file | run/attempt identity, monotonic sequence, timestamp, finite metrics | malformed or stale data is unavailable; do not use mtime alone as progress |
| `nvidia-smi`/NVML | GPU UUID, process association, memory/utilization if needed | command failure is unavailable; do not treat utilization as correctness |
| filesystem/artifact manifest | checkpoint path, size, digest, completion marker | partial or out-of-root artifact is failed/unknown |
| bounded logs | allowlisted regex signatures only | regex errors and missing logs are unavailable, not healthy |

The adapter should prefer structured state files written atomically by the executor. Shell commands
must be project-owned, bounded, and allowlisted; do not pass user-controlled text through a shell.
The adapter must not submit/cancel jobs, change hyperparameters, delete outputs, or repair queue
state.

## Terminal and recovery rules

`terminal` is valid only after all of the following have been independently checked:

```json
{
  "contractVerified": true,
  "artifactsVerified": true,
  "reconcileVerified": true,
  "allRanksExited": true
}
```

An executor crash while a run is active must remain distinguishable from a clean terminal record.
Emit `processAlive: false, identityMatches: false` without terminal gates for the former; the health
state machine will report a critical failure. Never turn a missing executor into `completed` merely
because a checkpoint exists.

## Mock-first verification

Before connecting a real server, run the adapter against fixtures for:

1. healthy executor with fresh progress and sufficient disk;
2. PID reuse or wrong campaign path;
3. Slurm pending, running, failed, timeout, and missing-job responses;
4. one missing or early-exited rank in a multi-rank launch;
5. stale progress, non-finite metrics, truncated checkpoint, and out-of-root artifact;
6. GPU probe unavailable or attached to a different job;
7. clean terminal record with all ranks exited;
8. adapter timeout, malformed JSON, and partial atomic writes.

Each fixture should assert both the emitted `HealthInput` and the resulting sentinel state/fingerprint.
Use fake clocks and short bounded files; do not run a full training job to validate these cases.
The existing process-boundary tests in `harness/ml/__tests__/health-adapter-process.test.ts` and
`sentinel-executor-integration.test.ts` are the baseline for a project adapter's own test suite.
