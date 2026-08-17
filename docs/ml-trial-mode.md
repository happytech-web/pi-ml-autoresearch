# Bounded ML Trial Mode

`pi-ml-autoresearch` is an execution harness for an already grilled and approved ML search. It
does not decide the experiment question, expand the search space, modify training code, or promote
a pilot into longer training.

## Authority boundaries

- `search.json` is an immutable approved revision for this campaign. Initialization records its
  digest, and later state mutations reject changes.
- Every runnable pilot appears in `approvedTrials` with an exact contract hash. The hash binds the
  command, guard, seed, config hash, Git commit, data/split, metric path shape, and budgets; run ID
  and output directory may change for an explicit retry.
- `TRIALS.md` is project evidence. `events.jsonl` is an operational event cache.
- A reconciliation mismatch in row order or content fails closed before any mutation; this version
  never repairs or overwrites Markdown.
- The local runner accepts an executable plus argument array. Shell behavior must be explicit, for
  example `{"executable":"bash","args":["-lc","..."]}`.
- Successful process exit is not a successful trial. A finite primary metric must exist under the
  configured key in `metricFile`.
- Promotion and confirmation are user checkpoints outside this harness.
- The local adapter requires `workdir` to be at the approved Git commit with no tracked changes.

## Search configuration

```json
{
  "schemaVersion": 1,
  "experimentId": "exp-lr-selection",
  "searchRevision": "rev-1",
  "approval": "approved",
  "agentLevel": 1,
  "primaryMetric": {
    "name": "validation_action_mse",
    "direction": "lower",
    "minimumMeaningfulImprovement": 0.01
  },
  "budget": {
    "maxTrials": 3,
    "maxParallel": 1,
    "maxGpuHours": 6,
    "maxWallClockMinutes": 120,
    "maxFailures": 2,
    "maxRetriesPerTrial": 1
  },
  "approvedTrials": [
    {
      "trialId": "lr-0001",
      "contractHash": "sha256:..."
    }
  ],
  "paths": {
    "trialsMarkdown": "../TRIALS.md",
    "outputRoot": "/absolute/output"
  }
}
```

Level 2 additionally requires `maxLevel2Cycles`. This initial runner does not generate candidates;
the field exists so later adapters cannot accidentally run an unbounded loop.

## Trial configuration

```json
{
  "schemaVersion": 1,
  "trialId": "lr-0001",
  "runId": "lr-0001-run-1",
  "searchRevision": "rev-1",
  "phase": "pilot",
  "seed": 7,
  "configHash": "sha256:...",
  "gitSha": "0123456789abcdef0123456789abcdef01234567",
  "workdir": "/absolute/project/path",
  "outputDir": "/absolute/output/lr-0001-run-1",
  "command": {
    "executable": "bash",
    "args": ["scripts/run-approved-pilot.sh", "lr=0.0001"]
  },
  "guardCommand": {
    "executable": "bash",
    "args": ["scripts/check-approved-pilot.sh"]
  },
  "metricFile": "/absolute/output/lr-0001-run-1/metric.json",
  "dataset": "dataset-manifest-v3",
  "split": "validation-v2",
  "budget": {
    "stepLimit": 16000,
    "wallClockMinutes": 120,
    "gpuCount": 1,
    "gpuHours": 2
  }
}
```

Before approving `search.json`, calculate each contract hash from its trial template:

```bash
pi-ml-autoresearch hash-trial --trial trial-lr-0001.json
```

The retry fields `runId`, `outputDir`, `retryOfRunId`, and the absolute prefix of `metricFile` are
run-specific. All other contract fields stay fixed. The training/evaluation command must write
strict JSON:

```json
{ "validation_action_mse": 0.123 }
```

## CLI

```bash
pi-ml-autoresearch init --campaign .ml-coding/exp-lr/.runner --config search.json
pi-ml-autoresearch submit --campaign .ml-coding/exp-lr/.runner --trial trial-lr-0001.json
pi-ml-autoresearch poll --campaign .ml-coding/exp-lr/.runner --trial-id lr-0001
pi-ml-autoresearch status --campaign .ml-coding/exp-lr/.runner
pi-ml-autoresearch reconcile --campaign .ml-coding/exp-lr/.runner
pi-ml-autoresearch cancel --campaign .ml-coding/exp-lr/.runner --trial-id lr-0001
```

The worker is detached from the Pi process. Reopening Pi or starting a new session does not stop a
local trial; the next `poll` reads its status file and records the terminal event. Campaign writes
use a single-writer lock, and `preflight` reservations count against parallelism before launch.

`gpuHours` is a conservative reservation charged at `trial-started`, not measured utilization. It
must be at least `wallClockMinutes / 60 * gpuCount`; unused reservation is not reclaimed in this
version. A `preflight` also reserves its declared GPU-hours until launch or cancellation, so
parallel submissions cannot overbook the campaign ceiling. The worker enforces wall clock on the
whole Unix process group. It exports
`PI_ML_STEP_LIMIT`, but the training command and guard are responsible for enforcing the declared
step boundary.

Cancellation is confirmation-based: the ledger is not marked `abandoned` until the worker has
terminated its child process group. A failed confirmation leaves the trial `running` and reports an
error for operator follow-up. The submitted command must remain the foreground leader for all of
its training processes; if it exits while descendants remain, the worker kills that process group
and marks the run failed. `cancel` can also release a `preflight` left behind by an interrupted
submit; this records an `invalid` terminal event without claiming that training ran.

The supervisor persists a per-run UUID identity before the training command starts. If the outer
worker dies before that process-group identity becomes visible, the harness keeps the ledger
`running` and requires operator recovery; it does not guess that the GPU process is gone.

## Optional pi-goal bridge

Install `@narumitw/pi-goal`, enable its managed-run RPC in `/goal settings`, then run:

```text
/ml-search-goal .ml-coding/exp-lr/.runner
```

The bridge starts at most one active/requested bounded goal for the approved revision and reports managed-run state. If the
extension is absent or RPC is disabled, the campaign remains usable and the command reports a
warning. `goal-run.json` is a session bridge cache, not trial evidence. Cancelling the goal does not
cancel an active training process; run `pi-ml-autoresearch cancel` separately and verify its terminal
status.

## Deliberate omissions

- no candidate generation;
- no automatic promotion or fallback winner;
- no production-code mutation;
- no automatic ledger repair;
- no SSH/tmux, scheduler, Kubernetes, or Hugging Face runner yet;
- no dashboard projection for ML trial states yet.

The next adapter should implement the same submit/poll/cancel/collect contract for SSH/tmux without
changing campaign state or evidence semantics.
