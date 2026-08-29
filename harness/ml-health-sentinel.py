#!/usr/bin/env python3
"""Deterministic, standard-library ML health sidecar.

The sidecar consumes a project adapter's JSON observation and writes health state
and append-only events. It never starts training, changes experiment contracts, or
accesses the network. A project-specific adapter may refresh the input JSON before
each probe with process, progress, disk, and artifact observations.
"""

from __future__ import annotations

import argparse
import datetime as dt
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
from typing import Any


STOP = False


def now_ms() -> int:
    return int(time.time() * 1000)


def stable_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def digest(value: Any) -> str:
    return "sha256:" + hashlib.sha256(stable_json(value).encode("utf-8")).hexdigest()


def write_json_atomic(file: Path, value: Any) -> None:
    file.parent.mkdir(parents=True, exist_ok=True)
    temporary = file.with_name(f"{file.name}.tmp-{os.getpid()}")
    with temporary.open("w", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, file)
    os.chmod(file, 0o600)


def evidence(
    detector: str,
    reason_code: str,
    severity: str,
    confidence: float,
    detail: str,
) -> dict[str, Any]:
    return {
        "detector": detector,
        "reasonCode": reason_code,
        "severity": severity,
        "confidence": confidence,
        "detail": detail,
    }


def validate_policy(policy: dict[str, Any]) -> None:
    stale_value = policy.get("stale")
    disk_value = policy.get("disk")
    stale = stale_value if isinstance(stale_value, dict) else {}
    disk = disk_value if isinstance(disk_value, dict) else {}
    required_keys = (
        "warningMs",
        "confirmationMs",
    )
    if any(key not in stale for key in required_keys):
        raise ValueError("health policy stale.warningMs and stale.confirmationMs are required")
    disk_keys = (
        "warningBytes",
        "criticalBytes",
        "warningPercent",
        "criticalPercent",
        "warningInodes",
        "criticalInodes",
    )
    if any(key not in disk for key in disk_keys) or "sentinelHeartbeatMaxAgeMs" not in policy:
        raise ValueError("health policy disk thresholds and sentinelHeartbeatMaxAgeMs are required")
    required = [
        stale.get("warningMs"),
        stale.get("confirmationMs"),
        policy.get("sentinelHeartbeatMaxAgeMs"),
        disk.get("warningBytes"),
        disk.get("criticalBytes"),
        disk.get("warningPercent"),
        disk.get("criticalPercent"),
        disk.get("warningInodes"),
        disk.get("criticalInodes"),
    ]
    if any(
        isinstance(item, bool)
        or not isinstance(item, (int, float))
        or not math.isfinite(item)
        or item < 0
        for item in required
    ):
        raise ValueError("health policy thresholds must be non-negative finite numbers")
    if stale["confirmationMs"] < stale["warningMs"]:
        raise ValueError("stale.confirmationMs must be >= stale.warningMs")


def terminal_verified(value: Any) -> bool:
    return isinstance(value, dict) and all(
        value.get(key) is True
        for key in ("contractVerified", "artifactsVerified", "reconcileVerified", "allRanksExited")
    )


def finite_non_negative(value: Any) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(value)
        and value >= 0
    )


def observe_health(policy: dict[str, Any], payload: dict[str, Any], previous_state: str | None) -> dict[str, Any]:
    validate_policy(policy)
    now = payload.get("nowMs", now_ms())
    if not finite_non_negative(now):
        raise ValueError("input.nowMs must be a finite non-negative number")
    campaign_value = payload.get("campaignId", "")
    run_value = payload.get("runId", "")
    attempt_value = payload.get("attemptId", "")
    if not all(
        isinstance(value, str) and value.strip()
        for value in (campaign_value, run_value, attempt_value)
    ):
        raise ValueError("campaignId, runId and attemptId are required")
    campaign_id = campaign_value
    run_id = run_value
    attempt_id = attempt_value

    items: list[dict[str, Any]] = []
    heartbeat = payload.get("sentinelHeartbeatAtMs")
    heartbeat_age = None if not finite_non_negative(heartbeat) else max(0, now - heartbeat)
    if heartbeat_age is None or heartbeat_age > policy["sentinelHeartbeatMaxAgeMs"]:
        items.append(
            evidence(
                "sentinel-heartbeat",
                "sentinel-heartbeat-stale",
                "warning",
                0.9,
                "sentinel heartbeat unavailable" if heartbeat_age is None else f"heartbeat age {heartbeat_age}ms",
            )
        )

    executor_value = payload.get("executor")
    executor = executor_value if isinstance(executor_value, dict) else {}
    expected_stopped = executor.get("expectedStopped") is True
    if expected_stopped and executor.get("processAlive") is not False:
        items.append(evidence("executor", "observation-unavailable", "warning", 0.99, "expectedStopped requires executor processAlive=false"))
    elif executor.get("processAlive") is False and not expected_stopped:
        items.append(evidence("executor", "executor-not-running", "critical", 0.99, "executor process is not alive"))
    elif executor.get("identityMatches") is False and not expected_stopped:
        items.append(evidence("executor", "executor-identity-mismatch", "critical", 0.99, "executor identity does not match campaign"))
    elif not expected_stopped and (executor.get("processAlive") is not True or executor.get("identityMatches") is not True):
        items.append(evidence("executor", "observation-unavailable", "warning", 0.8, "executor observation unavailable"))

    fatal_signatures = payload.get("fatalSignatures")
    if fatal_signatures is not None and (
        not isinstance(fatal_signatures, list)
        or any(not isinstance(signature, str) for signature in fatal_signatures)
    ):
        items.append(
            evidence(
                "log-signature",
                "observation-unavailable",
                "warning",
                0.8,
                "fatal signature observation is malformed",
            )
        )
    else:
        for signature in fatal_signatures or []:
            items.append(evidence("log-signature", "fatal-signature", "critical", 0.95, signature))

    progress = payload.get("progress")
    if not isinstance(progress, dict):
        detail = "progress signal unavailable" if "progress" not in payload else "progress observation is malformed"
        items.append(evidence("progress-contract", "observation-unavailable", "warning", 0.8, detail))
    else:
        if progress.get("runId") != run_id or progress.get("attemptId") != attempt_id:
            items.append(evidence("progress-contract", "observation-unavailable", "critical", 0.99, "progress identity does not match run"))
        if progress.get("finiteMetrics") is False:
            items.append(evidence("progress-contract", "nan-or-inf", "critical", 0.99, "progress metric contains NaN or Inf"))
        timestamp = progress.get("timestampMs")
        if finite_non_negative(timestamp):
            age = max(0, now - timestamp)
            stale = policy["stale"]
            stale_probe_count = payload.get("staleProbeCount", 0)
            if not isinstance(stale_probe_count, int) or isinstance(stale_probe_count, bool) or stale_probe_count < 0:
                stale_probe_count = 0
            if age >= stale["confirmationMs"] and stale_probe_count >= 2:
                items.append(evidence("progress-stale", "progress-stale", "critical", 0.9, f"progress age {age}ms"))
            elif age >= stale["warningMs"]:
                items.append(evidence("progress-stale", "progress-stale", "warning", 0.85, f"progress age {age}ms"))
        else:
            items.append(evidence("progress-contract", "observation-unavailable", "warning", 0.8, "progress timestamp unavailable"))

    disk = payload.get("disk")
    if not isinstance(disk, dict):
        items.append(evidence("disk", "observation-unavailable", "warning", 0.8, "disk observation unavailable"))
    else:
        available_bytes = disk.get("availableBytes")
        available_percent = disk.get("availablePercent")
        available_inodes = disk.get("availableInodes")
        if not all(finite_non_negative(value) for value in (available_bytes, available_percent, available_inodes)):
            items.append(evidence("disk", "observation-unavailable", "warning", 0.8, "disk observation is malformed"))
        else:
            thresholds = policy["disk"]
            if available_bytes <= thresholds["criticalBytes"] or available_percent <= thresholds["criticalPercent"]:
                items.append(evidence("disk", "disk-headroom-critical", "critical", 0.99, f"bytes={available_bytes}, percent={available_percent}"))
            elif available_bytes <= thresholds["warningBytes"] or available_percent <= thresholds["warningPercent"]:
                items.append(evidence("disk", "disk-headroom-low", "warning", 0.95, f"bytes={available_bytes}, percent={available_percent}"))
            if available_inodes <= thresholds["criticalInodes"]:
                items.append(evidence("inode", "inode-headroom-critical", "critical", 0.99, f"inodes={available_inodes}"))
            elif available_inodes <= thresholds["warningInodes"]:
                items.append(evidence("inode", "inode-headroom-low", "warning", 0.95, f"inodes={available_inodes}"))

    critical = any(item["severity"] == "critical" for item in items)
    warning = any(item["severity"] == "warning" for item in items)
    unknown = any(item["reasonCode"] in {"observation-unavailable", "sentinel-heartbeat-stale"} for item in items)
    state = "completed" if terminal_verified(payload.get("terminal")) and not critical and not unknown else (
        "failed" if critical else "unknown" if unknown else "degraded" if warning else "healthy"
    )
    if state == "recovered" or (state == "healthy" and previous_state in {"degraded", "unknown"}):
        state = "recovered"
        items.append(evidence("state-machine", "progress-restored", "info", 0.9, "health returned to a valid observable state"))

    normalized = []
    for item in items:
        normalized_item = {
            "detector": item["detector"],
            "reasonCode": item["reasonCode"],
            "severity": item["severity"],
            "confidence": item["confidence"],
        }
        if item["reasonCode"] == "fatal-signature":
            normalized_item["signature"] = item["detail"]
        normalized.append(normalized_item)
    normalized.sort(key=stable_json)
    result = {
        "schemaVersion": 1,
        "campaignId": campaign_id,
        "runId": run_id,
        "attemptId": attempt_id,
        "observedAtMs": now,
        "state": state,
        "evidence": items,
    }
    result["fingerprint"] = digest(
        {
            "campaignId": campaign_id,
            "runId": run_id,
            "attemptId": attempt_id,
            "state": state,
            "evidence": normalized,
        }
    )
    return result


def read_json(file: Path) -> dict[str, Any]:
    with file.open("r", encoding="utf-8") as handle:
        value = json.load(handle)
    if not isinstance(value, dict):
        raise ValueError(f"{file} must contain a JSON object")
    return value


def fallback_identity(adapter_config: Path | None) -> dict[str, str]:
    """Keep only an independently declared identity when an adapter cannot refresh."""
    candidates: list[dict[str, Any]] = []
    if adapter_config is not None:
        try:
            configured = read_json(adapter_config)
            candidates.append(configured)
        except (OSError, ValueError, json.JSONDecodeError):
            pass
    for candidate in candidates:
        identity = {
            key: candidate.get(key)
            for key in ("campaignId", "runId", "attemptId")
        }
        if all(isinstance(value, str) and value.strip() for value in identity.values()):
            return identity
    raise ValueError("adapter refresh failed and no valid campaign identity is available")


def probe(args: argparse.Namespace) -> dict[str, Any]:
    output = args.output.expanduser().resolve()
    events = args.events.expanduser().resolve()
    lock_path = output.with_name(f".{output.name}.lock")
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("w", encoding="utf-8") as lock_handle:
        os.chmod(lock_path, 0o600)
        fcntl.flock(lock_handle.fileno(), fcntl.LOCK_EX)
        previous = read_json(output) if output.exists() else None
        previous_state = previous.get("state") if previous else None
        payload: dict[str, Any]
        if args.adapter:
            adapter_command = [
                sys.executable,
                str(args.adapter),
                "--config",
                str(args.adapter_config),
                "--output",
                str(args.input),
            ]
            try:
                adapter_result = subprocess.run(
                    adapter_command,
                    check=False,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    timeout=30,
                    text=True,
                )
            except (OSError, subprocess.TimeoutExpired):
                adapter_result = None
            if adapter_result is None or adapter_result.returncode != 0:
                # Preserve only identity and invalidate every observation when refresh fails.
                payload = fallback_identity(args.adapter_config)
                payload.update(
                    {
                        "nowMs": now_ms(),
                        "sentinelHeartbeatAtMs": None,
                        "executor": {},
                    }
                )
            else:
                payload = read_json(args.input)
        else:
            payload = read_json(args.input)
        observation = observe_health(read_json(args.policy), payload, previous_state)
        write_json_atomic(output, observation)
        previous_fingerprint = previous.get("fingerprint") if previous else None
        if previous_fingerprint != observation["fingerprint"] or previous_state != observation["state"]:
            events.parent.mkdir(parents=True, exist_ok=True)
            with events.open("a", encoding="utf-8") as handle:
                os.chmod(events, 0o600)
                handle.write(json.dumps(observation, ensure_ascii=False, separators=(",", ":")) + "\n")
                handle.flush()
                os.fsync(handle.fileno())
        fcntl.flock(lock_handle.fileno(), fcntl.LOCK_UN)
    return observation


def stop(_signum: int, _frame: Any) -> None:
    global STOP
    STOP = True


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--policy", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--events", required=True, type=Path)
    parser.add_argument("--adapter", type=Path, help="optional project adapter script")
    parser.add_argument("--adapter-config", type=Path, help="config passed to --adapter")
    parser.add_argument("--interval-seconds", type=float, default=0)
    args = parser.parse_args()
    if bool(args.adapter) != bool(args.adapter_config):
        raise ValueError("--adapter and --adapter-config must be supplied together")
    if args.interval_seconds < 0:
        raise ValueError("--interval-seconds must be non-negative")
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    while True:
        print(json.dumps(probe(args), ensure_ascii=False), flush=True)
        if args.interval_seconds == 0 or STOP:
            return 0
        time.sleep(args.interval_seconds)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f"ml-health-sentinel: {error}", flush=True)
        raise SystemExit(2)
