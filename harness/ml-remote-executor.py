#!/usr/bin/env python3

"""Run an approved fixed ML trial queue on the final training host."""

from __future__ import annotations

import argparse
import datetime as dt
from decimal import Decimal
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time
import uuid
from typing import Any, TextIO


STATE_FILE = "remote-state.json"
EVENTS_FILE = "remote-events.jsonl"
RUNS_DIR = "remote-runs"
LOCK_FILE = ".remote-executor.lock"
SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")
GIT_SHA = re.compile(r"^[0-9a-f]{40}([0-9a-f]{24})?$")
TERMINAL_CAMPAIGN_STATES = {"completed", "stopped", "cancelled"}
TERMINAL_RUN_STATES = {"pilot-complete", "completed", "failed", "invalid", "abandoned"}

cancel_requested = False
active_process: subprocess.Popen[bytes] | None = None


class ContractError(RuntimeError):
    pass


class ProcessCleanupError(ContractError):
    pass


def now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def read_json(file: Path) -> Any:
    with file.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def write_json_atomic(file: Path, value: Any) -> None:
    file.parent.mkdir(parents=True, exist_ok=True)
    temporary = file.with_name(f"{file.name}.tmp-{os.getpid()}")
    with temporary.open("w", encoding="utf-8") as handle:
        json.dump(value, handle, indent=2, ensure_ascii=False)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, file)


def js_number(value: float) -> str:
    if not math.isfinite(value):
        raise ContractError("Non-finite number in contract")
    if value == 0:
        return "0"
    if value.is_integer() and abs(value) < 1e21:
        return str(int(value))
    if 1e-6 <= abs(value) < 1e21:
        return format(Decimal(repr(value)), "f").rstrip("0").rstrip(".")
    rendered = repr(value).lower()
    if "e" in rendered:
        mantissa, exponent = rendered.split("e", 1)
        rendered = f"{mantissa}e{int(exponent):+d}"
    return rendered


def canonical_json(value: Any) -> str:
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return js_number(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, list):
        return "[" + ",".join(canonical_json(item) for item in value) + "]"
    if isinstance(value, dict):
        entries = []
        for key in sorted(value):
            entries.append(f"{canonical_json(str(key))}:{canonical_json(value[key])}")
        return "{" + ",".join(entries) + "}"
    raise ContractError(f"Unsupported JSON value: {type(value).__name__}")


def digest(value: Any) -> str:
    payload = canonical_json(value).encode("utf-8")
    return "sha256:" + hashlib.sha256(payload).hexdigest()


def absolute(path: str) -> str:
    return os.path.abspath(os.path.expanduser(path))


def require_inside(root: str, candidate: str, name: str) -> None:
    resolved_root = os.path.realpath(absolute(root))
    resolved_candidate = os.path.realpath(absolute(candidate))
    try:
        inside = os.path.commonpath([resolved_root, resolved_candidate]) == resolved_root
    except ValueError:
        inside = False
    if not inside:
        raise ContractError(f"{name} escapes approved root: {candidate}")


def trial_contract_hash(trial: dict[str, Any]) -> str:
    metric_relative = os.path.relpath(
        absolute(trial["metricFile"]), absolute(trial["outputDir"])
    )
    contract = {
        "schemaVersion": trial["schemaVersion"],
        "trialId": trial["trialId"],
        "searchRevision": trial["searchRevision"],
        "phase": trial["phase"],
        "seed": trial["seed"],
        "configHash": trial["configHash"],
        "gitSha": trial["gitSha"],
        "workdir": absolute(trial["workdir"]),
        "command": trial["command"],
        "metricRelativePath": metric_relative,
        "dataset": trial["dataset"],
        "split": trial["split"],
        "budget": trial["budget"],
    }
    if "guardCommand" in trial:
        contract["guardCommand"] = trial["guardCommand"]
    if "checkpoint" in trial:
        contract["checkpoint"] = trial["checkpoint"]
    return digest(contract)


def positive(name: str, value: Any, integer: bool = False) -> None:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value <= 0:
        raise ContractError(f"{name} must be positive")
    if integer and (not float(value).is_integer() or abs(value) > 2**53 - 1):
        raise ContractError(f"{name} must be a positive integer")


def command_spec(name: str, value: Any) -> None:
    if (
        not isinstance(value, dict)
        or not isinstance(value.get("executable"), str)
        or not value["executable"].strip()
    ):
        raise ContractError(f"{name}.executable is required")
    args = value.get("args", [])
    if not isinstance(args, list) or any(not isinstance(item, str) for item in args):
        raise ContractError(f"{name}.args must be an array of strings")
    unknown = set(value) - {"executable", "args"}
    if unknown:
        raise ContractError(f"{name} contains unsupported fields: {', '.join(sorted(unknown))}")


def validate_search(config: dict[str, Any]) -> None:
    if config.get("schemaVersion") != 1 or config.get("approval") != "approved":
        raise ContractError("search.json is not an approved schemaVersion 1 contract")
    for name in ("experimentId", "searchRevision"):
        if not SAFE_ID.fullmatch(str(config.get(name, ""))):
            raise ContractError(f"Invalid {name}")
    if config.get("agentLevel") not in (1, 2):
        raise ContractError("agentLevel must be 1 or 2")
    metric = config.get("primaryMetric", {})
    if metric.get("direction") not in ("lower", "higher") or not metric.get("name"):
        raise ContractError("Invalid primaryMetric")
    budget = config.get("budget", {})
    for name in ("maxTrials", "maxParallel", "maxFailures"):
        positive(name, budget.get(name), integer=True)
    for name in ("maxGpuHours", "maxWallClockMinutes"):
        positive(name, budget.get(name))
    retries = budget.get("maxRetriesPerTrial")
    if not isinstance(retries, int) or isinstance(retries, bool) or retries < 0:
        raise ContractError("maxRetriesPerTrial must be a non-negative integer")
    if config["agentLevel"] == 2:
        positive("maxLevel2Cycles", budget.get("maxLevel2Cycles"), integer=True)
    if budget["maxParallel"] > budget["maxTrials"]:
        raise ContractError("maxParallel cannot exceed maxTrials")
    approved = config.get("approvedTrials")
    if not isinstance(approved, list) or not approved:
        raise ContractError("approvedTrials must not be empty")
    if len(approved) > budget["maxTrials"]:
        raise ContractError("approvedTrials exceeds maxTrials")
    seen: set[str] = set()
    for item in approved:
        trial_id = item.get("trialId", "")
        if not SAFE_ID.fullmatch(trial_id) or not SHA256.fullmatch(item.get("contractHash", "")):
            raise ContractError("Invalid approved trial")
        if trial_id in seen:
            raise ContractError(f"Duplicate approved trial: {trial_id}")
        seen.add(trial_id)
    paths = config.get("paths", {})
    if not os.path.isabs(paths.get("outputRoot", "")):
        raise ContractError("paths.outputRoot must be absolute")


def validate_trial(config: dict[str, Any], trial: dict[str, Any]) -> None:
    if trial.get("schemaVersion") != 1:
        raise ContractError("Unsupported trial schemaVersion")
    if trial.get("searchRevision") != config["searchRevision"]:
        raise ContractError("Trial searchRevision does not match search.json")
    for name in (
        "trialId",
        "runId",
        "configHash",
        "gitSha",
        "workdir",
        "outputDir",
        "metricFile",
        "dataset",
        "split",
    ):
        if not isinstance(trial.get(name), str) or not trial[name]:
            raise ContractError(f"{name} is required")
    if not SAFE_ID.fullmatch(trial["trialId"]) or not SAFE_ID.fullmatch(trial["runId"]):
        raise ContractError("Invalid trialId or runId")
    for name in ("workdir", "outputDir", "metricFile"):
        if not os.path.isabs(trial[name]):
            raise ContractError(f"{name} must be absolute on the final training host")
    if not SHA256.fullmatch(trial["configHash"]) or not GIT_SHA.fullmatch(trial["gitSha"]):
        raise ContractError("Invalid configHash or gitSha")
    if trial.get("phase") != "pilot":
        raise ContractError("Remote executor only runs pilot trials")
    if not isinstance(trial.get("seed"), int) or isinstance(trial["seed"], bool):
        raise ContractError("seed must be an integer")
    command_spec("command", trial.get("command"))
    if "guardCommand" in trial:
        command_spec("guardCommand", trial["guardCommand"])
    budget = trial.get("budget", {})
    if not isinstance(budget, dict):
        raise ContractError("budget must be an object")
    unknown_budget = set(budget) - {"stepLimit", "wallClockMinutes", "gpuCount", "gpuHours"}
    if unknown_budget:
        raise ContractError(
            f"budget contains unsupported fields: {', '.join(sorted(unknown_budget))}"
        )
    positive("stepLimit", budget.get("stepLimit"), integer=True)
    positive("wallClockMinutes", budget.get("wallClockMinutes"))
    positive("gpuCount", budget.get("gpuCount"), integer=True)
    positive("gpuHours", budget.get("gpuHours"))
    if budget["wallClockMinutes"] > config["budget"]["maxWallClockMinutes"]:
        raise ContractError("Trial wall-clock budget exceeds search ceiling")
    if budget["gpuHours"] < budget["wallClockMinutes"] / 60 * budget["gpuCount"]:
        raise ContractError("gpuHours does not cover the wall-clock reservation")
    if absolute(trial["workdir"]) == absolute(trial["outputDir"]):
        raise ContractError("outputDir must not be the workdir root")
    if absolute(trial["metricFile"]) == absolute(trial["outputDir"]):
        raise ContractError("metricFile must name a file below outputDir")
    require_inside(config["paths"]["outputRoot"], trial["outputDir"], "outputDir")
    require_inside(trial["outputDir"], trial["metricFile"], "metricFile")
    approved = {item["trialId"]: item["contractHash"] for item in config["approvedTrials"]}
    if trial["trialId"] not in approved:
        raise ContractError(f"Unapproved trial: {trial['trialId']}")
    if trial_contract_hash(trial) != approved[trial["trialId"]]:
        raise ContractError(f"Trial contract hash mismatch: {trial['trialId']}")


def validate_queue(config: dict[str, Any], queue: dict[str, Any]) -> list[dict[str, Any]]:
    if queue.get("schemaVersion") != 1 or queue.get("searchRevision") != config["searchRevision"]:
        raise ContractError("Invalid queue schema or revision")
    trials = queue.get("trials")
    if not isinstance(trials, list) or not trials:
        raise ContractError("queue.json must contain trials")
    maximum = config["budget"]["maxTrials"] * (
        1 + config["budget"]["maxRetriesPerTrial"]
    )
    if len(trials) > maximum:
        raise ContractError("Queue exceeds approved trial and retry ceiling")
    runs: dict[str, dict[str, Any]] = {}
    retry_counts: dict[str, int] = {}
    trial_ids: set[str] = set()
    for trial in trials:
        if not isinstance(trial, dict):
            raise ContractError("Queue trial must be an object")
        validate_trial(config, trial)
        if trial["runId"] in runs:
            raise ContractError(f"Duplicate runId: {trial['runId']}")
        trial_ids.add(trial["trialId"])
        retry_of = trial.get("retryOfRunId")
        if retry_of:
            prior = runs.get(retry_of)
            if not prior or prior["trialId"] != trial["trialId"]:
                raise ContractError("Retry must reference an earlier run for the same trial")
            count = retry_counts.get(trial["trialId"], 0) + 1
            if count > config["budget"]["maxRetriesPerTrial"]:
                raise ContractError("Queue retry ceiling exceeded")
            retry_counts[trial["trialId"]] = count
        elif any(item["trialId"] == trial["trialId"] for item in runs.values()):
            raise ContractError("Repeated trial must declare retryOfRunId")
        runs[trial["runId"]] = trial
    if len(trial_ids) > config["budget"]["maxTrials"]:
        raise ContractError("Queue exceeds approved unique trial ceiling")
    return trials


def read_events(campaign: Path) -> list[dict[str, Any]]:
    file = campaign / EVENTS_FILE
    if not file.exists():
        return []
    events = []
    with file.open("r", encoding="utf-8") as handle:
        for expected, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            event = json.loads(line)
            if event.get("sequence") != expected:
                raise ContractError("Remote event sequence is not contiguous")
            events.append(event)
    return events


def append_event(campaign: Path, config: dict[str, Any], event_type: str, **values: Any) -> dict[str, Any]:
    events = read_events(campaign)
    sequence = len(events) + 1
    event = {
        "schemaVersion": 1,
        "eventId": f"remote-{sequence:06d}-{uuid.uuid4().hex[:8]}",
        "sequence": sequence,
        "timestamp": now(),
        "type": event_type,
        "experimentId": config["experimentId"],
        "searchRevision": config["searchRevision"],
        **values,
    }
    with (campaign / EVENTS_FILE).open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n")
        handle.flush()
        os.fsync(handle.fileno())
    return event


def load_contract(campaign: Path) -> tuple[dict[str, Any], dict[str, Any], list[dict[str, Any]]]:
    config = read_json(campaign / "search.json")
    queue = read_json(campaign / "queue.json")
    validate_search(config)
    trials = validate_queue(config, queue)
    return config, queue, trials


def git_guard(trial: dict[str, Any]) -> None:
    workdir = trial["workdir"]
    head = subprocess.run(
        ["git", "-C", workdir, "rev-parse", "HEAD"],
        check=False,
        capture_output=True,
        text=True,
        timeout=30,
    )
    if head.returncode != 0 or head.stdout.strip() != trial["gitSha"]:
        raise ContractError(f"workdir HEAD does not match {trial['gitSha']}")
    dirty = subprocess.run(
        ["git", "-C", workdir, "status", "--porcelain", "--untracked-files=no"],
        check=False,
        capture_output=True,
        text=True,
        timeout=30,
    )
    if dirty.returncode != 0 or dirty.stdout.strip():
        raise ContractError("workdir has tracked changes or Git status could not be verified")
    guard = trial.get("guardCommand")
    if guard:
        result = subprocess.run(
            [guard["executable"], *guard.get("args", [])],
            cwd=workdir,
            check=False,
            capture_output=True,
            text=True,
            timeout=300,
        )
        if result.returncode != 0:
            detail = "\n".join(item.strip() for item in (result.stderr, result.stdout) if item.strip())
            raise ContractError(f"Guard failed before launch{': ' + detail if detail else ''}")


def process_group_exists(process_group: int) -> bool:
    proc = Path("/proc")
    if proc.is_dir():
        for entry in proc.iterdir():
            if not entry.name.isdigit():
                continue
            try:
                stat = (entry / "stat").read_text(encoding="utf-8")
                fields_after_name = stat[stat.rfind(")") + 2 :].split()
                state = fields_after_name[0]
                group = int(fields_after_name[2])
            except (OSError, ValueError, IndexError):
                continue
            if group == process_group and state != "Z":
                return True
        return False
    observed = subprocess.run(
        ["ps", "-axo", "pgid=,state="],
        check=False,
        capture_output=True,
        text=True,
        timeout=10,
    )
    if observed.returncode == 0:
        for line in observed.stdout.splitlines():
            fields = line.split()
            if len(fields) >= 2 and fields[0] == str(process_group) and not fields[1].startswith("Z"):
                return True
        return False
    try:
        os.killpg(process_group, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def terminate_group(process: subprocess.Popen[bytes], grace_seconds: float = 5) -> None:
    process_group = process.pid
    if not process_group_exists(process_group):
        process.poll()
        return
    try:
        os.killpg(process_group, signal.SIGTERM)
    except ProcessLookupError:
        process.poll()
        return
    deadline = time.monotonic() + grace_seconds
    while process_group_exists(process_group) and time.monotonic() < deadline:
        time.sleep(0.1)
    if process_group_exists(process_group):
        try:
            os.killpg(process_group, signal.SIGKILL)
        except ProcessLookupError:
            pass
        deadline = time.monotonic() + 5
        while process_group_exists(process_group) and time.monotonic() < deadline:
            time.sleep(0.1)
    process.poll()
    if process_group_exists(process_group):
        raise ProcessCleanupError(f"Process group {process_group} could not be confirmed stopped")


def handle_signal(_signal: int, _frame: Any) -> None:
    global cancel_requested
    cancel_requested = True
    if active_process is not None:
        try:
            os.killpg(active_process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass


def run_status_file(campaign: Path, run_id: str) -> Path:
    return campaign / RUNS_DIR / run_id / "status.json"


def parse_metrics(trial: dict[str, Any], metric_name: str) -> tuple[float, dict[str, float]]:
    require_inside(trial["outputDir"], trial["metricFile"], "metricFile")
    payload = read_json(Path(trial["metricFile"]))
    primary = payload.get(metric_name) if isinstance(payload, dict) else None
    if isinstance(primary, bool) or not isinstance(primary, (int, float)) or not math.isfinite(primary):
        raise ContractError(f"Metric file must contain finite numeric key {metric_name}")
    secondary = {
        name: value
        for name, value in payload.items()
        if name != metric_name
        and not isinstance(value, bool)
        and isinstance(value, (int, float))
        and math.isfinite(value)
    }
    return float(primary), secondary


def latest_run_events(events: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    latest: dict[str, dict[str, Any]] = {}
    for event in events:
        if event.get("runId"):
            latest[event["runId"]] = event
    return latest


def run_trial(
    campaign: Path,
    config: dict[str, Any],
    state: dict[str, Any],
    trial: dict[str, Any],
) -> dict[str, Any]:
    global active_process
    git_guard(trial)
    if cancel_requested:
        raise ContractError("Campaign cancellation requested before trial launch")
    output_dir = Path(trial["outputDir"])
    if output_dir.exists() and any(output_dir.iterdir()):
        raise ContractError(f"outputDir is not empty: {output_dir}")
    output_dir.mkdir(parents=True, exist_ok=True)
    require_inside(config["paths"]["outputRoot"], str(output_dir), "outputDir")
    log_file = output_dir / "run.log"
    run_token = uuid.uuid4().hex
    started_at = now()
    state.update(
        {
            "currentTrialId": trial["trialId"],
            "currentRunId": trial["runId"],
            "updatedAt": started_at,
        }
    )
    write_json_atomic(campaign / STATE_FILE, state)
    append_event(
        campaign,
        config,
        "trial-started",
        trialId=trial["trialId"],
        runId=trial["runId"],
        status="running",
        gpuHours=trial["budget"]["gpuHours"],
        trial=trial,
    )

    environment = os.environ.copy()
    environment.update(
        {
            "PI_ML_TRIAL_ID": trial["trialId"],
            "PI_ML_RUN_ID": trial["runId"],
            "PI_ML_OUTPUT_DIR": trial["outputDir"],
            "PI_ML_METRIC_FILE": trial["metricFile"],
            "PI_ML_STEP_LIMIT": str(trial["budget"]["stepLimit"]),
            "PI_ML_REMOTE_RUN_TOKEN": run_token,
        }
    )
    timed_out = False
    error: str | None = None
    exit_code: int | None = None
    started_monotonic = time.monotonic()
    status_file = run_status_file(campaign, trial["runId"])
    status_file.parent.mkdir(parents=True, exist_ok=True)
    try:
        with log_file.open("ab") as log:
            active_process = subprocess.Popen(
                [trial["command"]["executable"], *trial["command"].get("args", [])],
                cwd=trial["workdir"],
                env=environment,
                stdin=subprocess.DEVNULL,
                stdout=log,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
            write_json_atomic(
                status_file,
                {
                    "schemaVersion": 1,
                    "state": "running",
                    "pid": active_process.pid,
                    "processGroup": active_process.pid,
                    "processStartTicks": process_start_ticks(active_process.pid),
                    "runToken": run_token,
                    "startedAt": started_at,
                    "logFile": str(log_file),
                },
            )
            deadline = started_monotonic + trial["budget"]["wallClockMinutes"] * 60
            while active_process.poll() is None:
                if cancel_requested:
                    terminate_group(active_process)
                    error = "Campaign cancellation requested"
                    break
                if time.monotonic() >= deadline:
                    timed_out = True
                    terminate_group(active_process)
                    error = "Remote trial exceeded wall-clock budget"
                    break
                time.sleep(0.2)
            exit_code = active_process.wait()
            if process_group_exists(active_process.pid):
                terminate_group(active_process)
                if error is None:
                    error = "Foreground leader exited while descendant processes remained"
    except Exception as exception:
        error = str(exception)
        if active_process is not None:
            terminate_group(active_process)
            exit_code = active_process.poll()
    finally:
        active_process = None

    finished_at = now()
    elapsed_hours = (time.monotonic() - started_monotonic) / 3600 * trial["budget"]["gpuCount"]
    status = "failed"
    primary: float | None = None
    secondary: dict[str, float] = {}
    if cancel_requested:
        status = "abandoned"
    elif exit_code == 0 and not timed_out and error is None:
        try:
            primary, secondary = parse_metrics(trial, config["primaryMetric"]["name"])
            status = "pilot-complete"
        except Exception as exception:
            status = "invalid"
            error = str(exception)
    elif error is None:
        error = f"Remote command failed with exit code {exit_code}"

    write_json_atomic(
        status_file,
        {
            "schemaVersion": 1,
            "state": "finished",
            "pid": None,
            "processGroup": None,
            "runToken": run_token,
            "startedAt": started_at,
            "finishedAt": finished_at,
            "exitCode": exit_code,
            "timedOut": timed_out,
            "error": error,
            "logFile": str(log_file),
        },
    )
    event = append_event(
        campaign,
        config,
        "trial-cancelled" if status == "abandoned" else "trial-finished",
        trialId=trial["trialId"],
        runId=trial["runId"],
        status=status,
        metric=primary,
        secondaryMetrics=secondary or None,
        gpuHours=elapsed_hours,
        detail=error or "Strict primary metric parsed from metricFile",
        trial=trial,
    )
    state.update({"currentTrialId": None, "currentRunId": None, "updatedAt": finished_at})
    write_json_atomic(campaign / STATE_FILE, state)
    return event


def process_start_ticks(pid: int) -> int | None:
    try:
        stat = Path(f"/proc/{pid}/stat").read_text(encoding="utf-8")
        fields_after_name = stat[stat.rfind(")") + 2 :].split()
        return int(fields_after_name[19])
    except (OSError, ValueError, IndexError):
        return None


def process_identity_matches(pid: int, start_ticks: int, campaign: Path) -> bool:
    if process_start_ticks(pid) != start_ticks:
        return False
    try:
        command = Path(f"/proc/{pid}/cmdline").read_bytes().split(b"\0")
    except OSError:
        return False
    decoded = [part.decode("utf-8", errors="replace") for part in command if part]
    try:
        campaign_arg = decoded[decoded.index("--campaign") + 1]
        process_cwd = Path(f"/proc/{pid}/cwd").resolve()
        process_campaign = (process_cwd / campaign_arg).resolve()
    except (ValueError, IndexError, OSError):
        return False
    return (
        any(part.endswith("remote-executor.py") for part in decoded)
        and "run" in decoded
        and process_campaign == campaign
    )


def acquire_run_lock(campaign: Path) -> TextIO:
    lock = (campaign / LOCK_FILE).open("a+", encoding="utf-8")
    try:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError as error:
        lock.close()
        raise ContractError("Remote campaign already has an active executor") from error
    lock.seek(0)
    lock.truncate()
    lock.write(f"{os.getpid()}\n")
    lock.flush()
    os.fsync(lock.fileno())
    return lock


def refresh_interrupted_state(campaign: Path, state: dict[str, Any]) -> dict[str, Any]:
    if state.get("status") != "running":
        return state
    pid = state.get("executorPid")
    ticks = state.get("executorStartTicks")
    if (
        isinstance(pid, int)
        and isinstance(ticks, int)
        and process_identity_matches(pid, ticks, campaign)
    ):
        return state

    events = read_events(campaign)
    current_run = state.get("currentRunId")
    latest = latest_run_events(events).get(current_run) if current_run else None
    if current_run and (not latest or latest.get("status") not in TERMINAL_RUN_STATES):
        state.update(
            {
                "status": "recovery-required",
                "stopReason": "Executor disappeared while a trial was active",
                "updatedAt": now(),
            }
        )
    else:
        state.update(
            {
                "status": "interrupted",
                "stopReason": "Executor exited between trials; run may safely resume",
                "currentTrialId": None,
                "currentRunId": None,
                "updatedAt": now(),
            }
        )
    write_json_atomic(campaign / STATE_FILE, state)
    return state


def initialize_state(
    campaign: Path, config: dict[str, Any], queue: dict[str, Any]
) -> dict[str, Any]:
    file = campaign / STATE_FILE
    config_digest = digest(config)
    queue_digest = digest(queue)
    if file.exists():
        state = read_json(file)
        if state.get("configDigest") != config_digest or state.get("queueDigest") != queue_digest:
            raise ContractError("Remote search or queue changed after campaign initialization")
        state = refresh_interrupted_state(campaign, state)
        if state.get("status") in TERMINAL_CAMPAIGN_STATES:
            return state
        old_pid = state.get("executorPid")
        old_start_ticks = state.get("executorStartTicks")
        if (
            isinstance(old_pid, int)
            and isinstance(old_start_ticks, int)
            and process_identity_matches(old_pid, old_start_ticks, campaign)
        ):
            raise ContractError(f"Remote campaign is already running as pid {old_pid}")
        if state.get("status") == "recovery-required" or state.get("currentRunId"):
            raise ContractError("Active trial identity is unresolved; operator recovery required")
    else:
        events = read_events(campaign)
        if events:
            initialized = events[0]
            if (
                len(events) != 1
                or initialized.get("type") != "campaign-initialized"
                or initialized.get("configDigest") != config_digest
                or initialized.get("queueDigest") != queue_digest
            ):
                raise ContractError("Remote initialization was interrupted with inconsistent events")
        state = {
            "schemaVersion": 1,
            "status": "running",
            "configDigest": config_digest,
            "queueDigest": queue_digest,
            "startedAt": events[0]["timestamp"] if events else now(),
            "currentTrialId": None,
            "currentRunId": None,
        }
        if not events:
            append_event(
                campaign,
                config,
                "campaign-initialized",
                status="planned",
                configDigest=config_digest,
                queueDigest=queue_digest,
            )
    start_ticks = process_start_ticks(os.getpid())
    state.update(
        {
            "status": "running",
            "executorPid": os.getpid(),
            "executorStartTicks": start_ticks,
            "updatedAt": now(),
            "stopReason": None,
        }
    )
    write_json_atomic(file, state)
    return state


def target_reached(config: dict[str, Any], metric: float | None) -> bool:
    target = config["primaryMetric"].get("target")
    if target is None or metric is None:
        return False
    if config["primaryMetric"]["direction"] == "lower":
        return metric <= target
    return metric >= target


def run_campaign(campaign: Path) -> dict[str, Any]:
    config, queue, trials = load_contract(campaign)
    state = initialize_state(campaign, config, queue)
    if state["status"] in TERMINAL_CAMPAIGN_STATES:
        events = read_events(campaign)
        if not any(event.get("type") == "campaign-finished" for event in events):
            append_event(
                campaign,
                config,
                "campaign-finished",
                status=state["status"],
                detail=state.get("stopReason"),
            )
        return state
    events = read_events(campaign)
    latest = latest_run_events(events)
    failures = sum(
        1 for event in events if event.get("type") == "trial-finished" and event.get("status") == "failed"
    )
    charged_gpu_hours = sum(
        event.get("gpuHours", 0) for event in events if event.get("type") == "trial-started"
    )
    started_trials = {
        event["trialId"] for event in events if event.get("type") == "trial-started"
    }

    for trial in trials:
        if cancel_requested:
            break
        if trial["runId"] in latest:
            continue
        retry_of = trial.get("retryOfRunId")
        if retry_of:
            prior = latest.get(retry_of)
            if not prior or prior.get("status") != "failed":
                continue
        if failures >= config["budget"]["maxFailures"]:
            state.update({"status": "stopped", "stopReason": "Failure ceiling reached"})
            break
        if trial["trialId"] not in started_trials and len(started_trials) >= config["budget"]["maxTrials"]:
            state.update({"status": "stopped", "stopReason": "Trial ceiling reached"})
            break
        if charged_gpu_hours + trial["budget"]["gpuHours"] > config["budget"]["maxGpuHours"]:
            state.update({"status": "stopped", "stopReason": "GPU-hour ceiling reached"})
            break

        try:
            result = run_trial(campaign, config, state, trial)
        except ProcessCleanupError as error:
            state.update(
                {
                    "status": "recovery-required",
                    "stopReason": str(error),
                    "updatedAt": now(),
                }
            )
            write_json_atomic(campaign / STATE_FILE, state)
            raise
        except (ContractError, FileNotFoundError, subprocess.SubprocessError) as error:
            result = append_event(
                campaign,
                config,
                "trial-finished",
                trialId=trial["trialId"],
                runId=trial["runId"],
                status="invalid",
                detail=f"Remote preflight failed: {error}",
                trial=trial,
            )
        latest[trial["runId"]] = result
        started = any(
            event.get("type") == "trial-started" and event.get("runId") == trial["runId"]
            for event in read_events(campaign)
        )
        if started:
            charged_gpu_hours += trial["budget"]["gpuHours"]
            started_trials.add(trial["trialId"])
        if result["status"] == "failed":
            failures += 1
        if target_reached(config, result.get("metric")):
            state.update(
                {
                    "status": "stopped",
                    "stopReason": f"Approved primary metric target reached by {trial['trialId']}",
                }
            )
            break

    if cancel_requested:
        state.update({"status": "cancelled", "stopReason": "Campaign cancellation requested"})
    elif failures >= config["budget"]["maxFailures"] and state["status"] == "running":
        state.update({"status": "stopped", "stopReason": "Failure ceiling reached"})
    elif state["status"] == "running":
        state.update({"status": "completed", "stopReason": "Fixed approved queue exhausted"})
    state.update(
        {
            "executorPid": None,
            "executorStartTicks": None,
            "currentTrialId": None,
            "currentRunId": None,
            "updatedAt": now(),
        }
    )
    write_json_atomic(campaign / STATE_FILE, state)
    append_event(
        campaign,
        config,
        "campaign-finished",
        status=state["status"],
        detail=state["stopReason"],
    )
    return state


def reconcile(campaign: Path) -> dict[str, Any]:
    config, queue, _trials = load_contract(campaign)
    state = refresh_interrupted_state(campaign, read_json(campaign / STATE_FILE))
    events = read_events(campaign)
    problems = []
    if state.get("configDigest") != digest(config):
        problems.append("search.json digest mismatch")
    if state.get("queueDigest") != digest(queue):
        problems.append("queue.json digest mismatch")
    if not events or events[0].get("type") != "campaign-initialized":
        problems.append("missing campaign-initialized event")
    if state.get("currentRunId") and not any(
        event.get("runId") == state["currentRunId"] and event.get("status") == "running"
        for event in events
    ):
        problems.append("current run has no running event")
    if state.get("status") == "recovery-required":
        problems.append("executor disappeared while a trial was active; recovery required")
    if state.get("status") in TERMINAL_CAMPAIGN_STATES and not any(
        event.get("type") == "campaign-finished" for event in events
    ):
        problems.append("terminal campaign has no campaign-finished event")
    return {"ok": not problems, "problems": problems, "state": state}


def status(campaign: Path) -> dict[str, Any]:
    state = refresh_interrupted_state(campaign, read_json(campaign / STATE_FILE))
    events = read_events(campaign)
    latest: dict[str, dict[str, Any]] = {}
    for event in events:
        if event.get("trialId"):
            latest[event["trialId"]] = {
                key: event.get(key)
                for key in ("trialId", "runId", "status", "metric", "timestamp", "detail")
            }
    return {"state": state, "trials": list(latest.values()), "eventCount": len(events)}


def cancel(campaign: Path) -> dict[str, Any]:
    state = read_json(campaign / STATE_FILE)
    pid = state.get("executorPid")
    start_ticks = state.get("executorStartTicks")
    if (
        state.get("status") != "running"
        or not isinstance(pid, int)
        or not isinstance(start_ticks, int)
    ):
        raise ContractError("Remote campaign is not running")
    if not process_identity_matches(pid, start_ticks, campaign):
        raise ContractError("Remote executor identity cannot be verified; refusing to signal")
    os.kill(pid, signal.SIGTERM)
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        current = read_json(campaign / STATE_FILE)
        if current.get("status") != "running":
            if current.get("status") == "recovery-required":
                raise ContractError("Remote process-group cleanup was not confirmed")
            return current
        time.sleep(0.2)
    raise ContractError("Remote executor did not confirm cancellation")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("run", "status", "reconcile", "cancel"))
    parser.add_argument("--campaign", required=True, type=Path)
    args = parser.parse_args()
    campaign = args.campaign.expanduser().resolve()
    if not campaign.is_dir():
        raise ContractError(f"Campaign directory does not exist: {campaign}")
    if args.action == "run":
        signal.signal(signal.SIGTERM, handle_signal)
        signal.signal(signal.SIGINT, handle_signal)
        lock = acquire_run_lock(campaign)
        try:
            result = run_campaign(campaign)
        finally:
            fcntl.flock(lock.fileno(), fcntl.LOCK_UN)
            lock.close()
    elif args.action == "status":
        result = status(campaign)
    elif args.action == "reconcile":
        result = reconcile(campaign)
        if not result["ok"]:
            print(json.dumps(result, indent=2, ensure_ascii=False))
            return 2
    else:
        result = cancel(campaign)
    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ContractError, FileNotFoundError, json.JSONDecodeError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
