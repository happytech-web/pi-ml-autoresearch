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
    stale = policy.get("stale") or {}
    disk = policy.get("disk") or {}
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
    if any(isinstance(item, bool) or not isinstance(item, (int, float)) or item < 0 for item in required):
        raise ValueError("health policy thresholds must be non-negative numbers")
    if stale["confirmationMs"] < stale["warningMs"]:
        raise ValueError("stale.confirmationMs must be >= stale.warningMs")


def terminal_verified(value: Any) -> bool:
    return isinstance(value, dict) and all(
        value.get(key) is True
        for key in ("contractVerified", "artifactsVerified", "reconcileVerified", "allRanksExited")
    )


def observe_health(policy: dict[str, Any], payload: dict[str, Any], previous_state: str | None) -> dict[str, Any]:
    validate_policy(policy)
    now = payload.get("nowMs", now_ms())
    if isinstance(now, bool) or not isinstance(now, (int, float)):
        raise ValueError("input.nowMs must be a number")
    campaign_id = str(payload.get("campaignId", ""))
    run_id = str(payload.get("runId", ""))
    attempt_id = str(payload.get("attemptId", ""))
    if not campaign_id or not run_id or not attempt_id:
        raise ValueError("campaignId, runId and attemptId are required")

    items: list[dict[str, Any]] = []
    heartbeat = payload.get("sentinelHeartbeatAtMs")
    heartbeat_age = None if heartbeat is None else max(0, int(now - heartbeat))
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

    executor = payload.get("executor") or {}
    expected_stopped = executor.get("expectedStopped") is True
    if expected_stopped and executor.get("processAlive") is not False:
        items.append(evidence("executor", "observation-unavailable", "warning", 0.99, "expectedStopped requires executor processAlive=false"))
    elif executor.get("processAlive") is False and not expected_stopped:
        items.append(evidence("executor", "executor-not-running", "critical", 0.99, "executor process is not alive"))
    elif executor.get("identityMatches") is False and not expected_stopped:
        items.append(evidence("executor", "executor-identity-mismatch", "critical", 0.99, "executor identity does not match campaign"))
    elif not expected_stopped and (executor.get("processAlive") is not True or executor.get("identityMatches") is not True):
        items.append(evidence("executor", "observation-unavailable", "warning", 0.8, "executor observation unavailable"))

    for signature in payload.get("fatalSignatures") or []:
        items.append(evidence("log-signature", "fatal-signature", "critical", 0.95, str(signature)))

    progress = payload.get("progress")
    if not isinstance(progress, dict):
        items.append(evidence("progress-contract", "observation-unavailable", "warning", 0.8, "progress signal unavailable"))
    else:
        if progress.get("runId") != run_id or progress.get("attemptId") != attempt_id:
            items.append(evidence("progress-contract", "observation-unavailable", "critical", 0.99, "progress identity does not match run"))
        if progress.get("finiteMetrics") is False:
            items.append(evidence("progress-contract", "nan-or-inf", "critical", 0.99, "progress metric contains NaN or Inf"))
        timestamp = progress.get("timestampMs")
        if isinstance(timestamp, (int, float)) and not isinstance(timestamp, bool):
            age = max(0, int(now - timestamp))
            stale = policy["stale"]
            if age >= stale["confirmationMs"] and int(payload.get("staleProbeCount", 0)) >= 2:
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
        if not all(isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) for value in (available_bytes, available_percent, available_inodes)):
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
        "observedAtMs": int(now),
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
        payload = read_json(args.input)
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
                # Preserve run identity but invalidate all signals when the adapter cannot refresh.
                payload["nowMs"] = now_ms()
                payload["sentinelHeartbeatAtMs"] = None
                payload["executor"] = {}
                payload.pop("progress", None)
                payload.pop("disk", None)
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
