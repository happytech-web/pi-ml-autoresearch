#!/usr/bin/env python3
"""Build a deterministic HealthInput JSON from project-declared observations.

The adapter is intentionally conservative: absent or malformed files become
unavailable evidence for the sentinel; it never guesses that a process is
healthy, changes training configuration, or executes a remote command.
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


def require_string(config: dict[str, Any], key: str) -> str:
    value = config.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"adapter config {key} is required")
    return value


def disk_observation(path_value: str) -> dict[str, int | float] | None:
    try:
        usage = shutil.disk_usage(path_value)
        stat = os.statvfs(path_value)
        available_inodes = stat.f_bavail
        available_percent = usage.free / usage.total * 100 if usage.total else 0
        return {
            "availableBytes": usage.free,
            "availablePercent": available_percent,
            "availableInodes": available_inodes,
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
    campaign_id = require_string(config, "campaignId")
    run_id = require_string(config, "runId")
    attempt_id = require_string(config, "attemptId")
    result: dict[str, Any] = {
        "nowMs": now_ms(),
        "campaignId": campaign_id,
        "runId": run_id,
        "attemptId": attempt_id,
        "sentinelHeartbeatAtMs": now_ms(),
    }
    executor_file = config.get("executorFile")
    if isinstance(executor_file, str):
        executor = read_object(Path(executor_file))
        if executor is not None:
            result["executor"] = {
                "processAlive": executor.get("processAlive"),
                "identityMatches": executor.get("identityMatches"),
            }
            if "pid" in executor:
                result["executor"]["pid"] = executor["pid"]
    if "executor" not in result:
        result["executor"] = {}

    progress_file = config.get("progressFile")
    if isinstance(progress_file, str):
        progress = read_object(Path(progress_file))
        if progress is not None:
            result["progress"] = progress

    terminal_file = config.get("terminalFile")
    if isinstance(terminal_file, str):
        terminal = read_object(Path(terminal_file))
        if terminal is not None:
            result["terminal"] = terminal

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
        print(f"ml-health-adapter: {error}", flush=True)
        raise SystemExit(2)
