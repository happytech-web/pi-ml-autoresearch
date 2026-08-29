#!/usr/bin/env python3
"""Build HealthInput from the bundled remote-executor state on a Linux host.

This is a reference project adapter, not a scheduler client. It reads local state
and declared files only; it never submits, cancels, or restarts a remote job.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import shutil
import time
from typing import Any


TERMINAL_CAMPAIGN_STATES = {"completed", "stopped", "cancelled"}


def now_ms() -> int:
    return int(time.time() * 1000)


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


def read_object(file: Path) -> dict[str, Any] | None:
    try:
        with file.open("r", encoding="utf-8") as handle:
            value = json.load(handle)
        return value if isinstance(value, dict) else None
    except (OSError, ValueError, json.JSONDecodeError):
        return None


def required_string(config: dict[str, Any], key: str) -> str:
    value = config.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"adapter config {key} is required")
    return value


def exact_identity(value: Any, campaign_id: str, run_id: str, attempt_id: str) -> bool:
    return isinstance(value, dict) and all(
        value.get(key) == expected
        for key, expected in (
            ("campaignId", campaign_id),
            ("runId", run_id),
            ("attemptId", attempt_id),
        )
    )


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
        decoded = [part.decode("utf-8", errors="replace") for part in command if part]
        campaign_arg = decoded[decoded.index("--campaign") + 1]
        process_cwd = Path(f"/proc/{pid}/cwd").resolve()
        process_campaign = (process_cwd / campaign_arg).resolve()
    except (OSError, ValueError, IndexError):
        return False
    return (
        any(part.endswith("remote-executor.py") for part in decoded)
        and "run" in decoded
        and process_campaign == campaign
    )


def disk_observation(path_value: str) -> dict[str, int | float] | None:
    try:
        usage = shutil.disk_usage(path_value)
        stat = os.statvfs(path_value)
        return {
            "availableBytes": usage.free,
            "availablePercent": usage.free / usage.total * 100 if usage.total else 0,
            "availableInodes": stat.f_bavail,
        }
    except (OSError, ValueError):
        return None


def log_signatures(config: dict[str, Any]) -> list[str]:
    signatures: list[str] = []
    for item in config.get("logFiles") or []:
        if not isinstance(item, dict) or not isinstance(item.get("path"), str):
            continue
        try:
            text = Path(item["path"]).read_text(encoding="utf-8", errors="replace")[-128 * 1024 :]
        except OSError:
            continue
        patterns = item.get("patterns") or {}
        if not isinstance(patterns, dict):
            continue
        for name, pattern in sorted(patterns.items()):
            if not isinstance(name, str) or not isinstance(pattern, str) or len(pattern) > 512:
                continue
            try:
                if re.search(pattern, text, flags=re.IGNORECASE | re.MULTILINE):
                    signatures.append(name)
            except re.error:
                continue
    return sorted(set(signatures))


def build_input(config: dict[str, Any]) -> dict[str, Any]:
    campaign_id = required_string(config, "campaignId")
    run_id = required_string(config, "runId")
    attempt_id = required_string(config, "attemptId")
    campaign = Path(required_string(config, "campaignDir")).expanduser().resolve()
    state_file = Path(config.get("remoteStateFile", campaign / "remote-state.json")).expanduser()
    state = read_object(state_file)
    result: dict[str, Any] = {
        "nowMs": now_ms(),
        "campaignId": campaign_id,
        "runId": run_id,
        "attemptId": attempt_id,
        "sentinelHeartbeatAtMs": now_ms(),
        "executor": {},
    }

    if state is not None:
        status = state.get("status")
        pid = state.get("executorPid")
        ticks = state.get("executorStartTicks")
        configured_run_status = config.get("runStatusFile")
        run_status_file = (
            Path(configured_run_status).expanduser()
            if isinstance(configured_run_status, str)
            else campaign / "remote-runs" / run_id / "status.json"
        )
        run_status = read_object(run_status_file)
        run_status_matches = (
            isinstance(run_status, dict)
            and run_status.get("runId") == run_id
            and run_status.get("state") == "running"
            and isinstance(run_status.get("runToken"), str)
            and bool(run_status["runToken"])
            and state.get("currentRunToken") == run_status.get("runToken")
        )
        if status == "running":
            process_alive = (
                isinstance(pid, int)
                and isinstance(ticks, int)
                and process_start_ticks(pid) is not None
            )
            result["executor"] = {
                "processAlive": process_alive,
                "identityMatches": (
                    process_alive
                    and state.get("currentRunId") == run_id
                    and run_status_matches
                    and process_identity_matches(pid, ticks, campaign)
                ),
            }
        elif status in TERMINAL_CAMPAIGN_STATES:
            result["executor"] = {
                "processAlive": False,
                "identityMatches": False,
            }
            terminal_file = config.get("terminalFile")
            terminal = read_object(Path(terminal_file).expanduser()) if isinstance(terminal_file, str) else None
            if exact_identity(terminal, campaign_id, run_id, attempt_id) and all(
                terminal.get(key) is True
                for key in ("contractVerified", "artifactsVerified", "reconcileVerified", "allRanksExited")
            ):
                result["executor"]["expectedStopped"] = True

    for name in ("progressFile", "terminalFile"):
        file_value = config.get(name)
        if isinstance(file_value, str):
            value = read_object(Path(file_value).expanduser())
            if value is not None:
                result[name.removesuffix("File")] = value
    disk_path = config.get("diskPath")
    if isinstance(disk_path, str):
        disk = disk_observation(disk_path)
        if disk is not None:
            result["disk"] = disk
    signatures = log_signatures(config)
    if signatures:
        result["fatalSignatures"] = signatures
    stale_probe_count = config.get("staleProbeCount")
    if isinstance(stale_probe_count, int) and not isinstance(stale_probe_count, bool) and stale_probe_count >= 0:
        result["staleProbeCount"] = stale_probe_count
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    config = read_object(args.config)
    if config is None:
        raise ValueError("adapter config must contain a JSON object")
    write_json_atomic(args.output, build_input(config))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f"ml-remote-health-adapter: {error}", flush=True)
        raise SystemExit(2)
