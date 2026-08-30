#!/usr/bin/env python3
"""Small user-owned PTY lease daemon for interactive remote bootstrap commands.

The daemon owns the PTY independently of a Pi session.  A project may use a
bootstrap command such as ``uv run --script ~/script/blogin.py ...``; after the
interactive login completes, monitor clients can send bounded probe commands
over the Unix socket.  It never retries authentication or persists PTY output.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import pty
import signal
import socket
import subprocess
import threading
import time
import uuid
from typing import Any


STOP = False


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


class LeaseDaemon:
    def __init__(self, args: argparse.Namespace) -> None:
        self.socket_path = args.socket.expanduser().resolve()
        self.state_path = args.state.expanduser().resolve()
        self.ttl_ms = int(args.ttl_seconds * 1000)
        self.startup_timeout_ms = int(args.startup_timeout_seconds * 1000)
        self.probe_timeout_ms = int(args.probe_timeout_seconds * 1000)
        self.command = args.command
        self.allowed_probe_prefixes = tuple(args.allowed_probe_prefix or ())
        self.child: subprocess.Popen[bytes] | None = None
        self.master_fd: int | None = None
        self.lock = threading.RLock()
        self.output = bytearray()
        self.output_condition = threading.Condition(self.lock)
        self.generation = 0
        self.lease_id = f"lease-{uuid.uuid4()}"
        self.expires_at_ms = now_ms() + self.ttl_ms
        self.starting_deadline_ms: int | None = now_ms() + self.startup_timeout_ms
        self.status = "starting"
        self.error: str | None = None
        self.reader: threading.Thread | None = None

    def state(self) -> dict[str, Any]:
        child_pid = None
        if self.child is not None and self.child.poll() is None:
            child_pid = self.child.pid
        return {
            "schemaVersion": 1,
            "leaseId": self.lease_id,
            "transport": "background-pty",
            "status": self.status,
            "pid": child_pid,
            "createdAtMs": self.expires_at_ms - self.ttl_ms,
            "expiresAtMs": self.expires_at_ms,
            "readyDeadlineAtMs": self.starting_deadline_ms,
            "updatedAtMs": now_ms(),
            "error": self.error,
        }

    def persist(self) -> None:
        write_json_atomic(self.state_path, self.state())

    def start(self, activate: bool = False) -> None:
        if not self.command:
            raise ValueError("bootstrap command is required")
        master, slave = pty.openpty()
        try:
            self.child = subprocess.Popen(
                self.command,
                stdin=slave,
                stdout=slave,
                stderr=slave,
                start_new_session=True,
                close_fds=True,
            )
        finally:
            os.close(slave)
        self.master_fd = master
        os.set_blocking(master, False)
        self.status = "active" if activate else "starting"
        self.starting_deadline_ms = None if activate else now_ms() + self.startup_timeout_ms
        self.persist()
        self.generation += 1
        generation = self.generation
        self.reader = threading.Thread(
            target=self._read_output, args=(generation, master), daemon=True
        )
        self.reader.start()

    def _read_output(self, generation: int, master_fd: int) -> None:
        while not STOP:
            try:
                data = os.read(master_fd, 8192)
            except BlockingIOError:
                time.sleep(0.01)
                continue
            except OSError:
                break
            if not data:
                break
            with self.output_condition:
                self.output.extend(data)
                if len(self.output) > 1024 * 1024:
                    del self.output[:-512 * 1024]
                self.output_condition.notify_all()
        try:
            os.close(master_fd)
        except OSError:
            pass
        with self.lock:
            # A closed reader may race with reauthentication.  File descriptor
            # numbers can be reused, so generation must match before clearing
            # the currently active transport.
            if generation == self.generation and self.master_fd == master_fd:
                self.master_fd = None
            if generation == self.generation and self.status in {"active", "starting"}:
                self.status = "reauth-required"
                self.error = "bootstrap PTY exited or relay connection closed"
                self.persist()
            with self.output_condition:
                self.output_condition.notify_all()

    def check_expiry(self) -> None:
        with self.lock:
            if self.status in {"active", "starting"} and now_ms() >= self.expires_at_ms:
                self.status = "reauth-required"
                self.error = "connection lease expired; explicit reauthentication required"
                self._terminate_child()
                self.persist()
                return
            if (
                self.status == "starting"
                and self.starting_deadline_ms is not None
                and now_ms() >= self.starting_deadline_ms
            ):
                self.status = "reauth-required"
                self.error = "bootstrap readiness timed out; explicit reauthentication required"
                self._terminate_child()
                self.persist()

    def _terminate_child(self) -> None:
        child = self.child
        if child is None or child.poll() is not None:
            return
        try:
            os.killpg(child.pid, signal.SIGTERM)
        except OSError:
            try:
                child.terminate()
            except OSError:
                pass
        try:
            child.wait(timeout=1)
        except subprocess.TimeoutExpired:
            try:
                child.kill()
            except OSError:
                pass
            try:
                child.wait(timeout=1)
            except subprocess.TimeoutExpired:
                pass

    def stop(self) -> None:
        global STOP
        STOP = True
        with self.lock:
            self.generation += 1
            self._terminate_child()
            if self.master_fd is not None:
                try:
                    os.close(self.master_fd)
                except OSError:
                    pass
                self.master_fd = None
            if self.status != "stopped":
                self.status = "stopped"
                self.persist()

    def reauthenticate(self) -> None:
        with self.lock:
            if self.status != "reauth-required":
                raise RuntimeError("reauthentication is only allowed for an expired or closed lease")
            self.generation += 1
            old_child = self.child
            self._terminate_child()
            if self.master_fd is not None:
                try:
                    os.close(self.master_fd)
                except OSError:
                    pass
                self.master_fd = None
            self.child = None
            if old_child is not None:
                try:
                    old_child.wait(timeout=1)
                except subprocess.TimeoutExpired:
                    try:
                        old_child.kill()
                    except OSError:
                        pass
                    try:
                        old_child.wait(timeout=1)
                    except subprocess.TimeoutExpired:
                        pass
            self.output.clear()
            self.lease_id = f"lease-{uuid.uuid4()}"
            self.expires_at_ms = now_ms() + self.ttl_ms
            self.status = "starting"
            self.starting_deadline_ms = now_ms() + self.startup_timeout_ms
            self.error = None
            self.start(activate=False)

    def mark_ready(self) -> None:
        with self.lock:
            if self.status != "starting":
                raise RuntimeError("lease is not waiting for bootstrap readiness")
            if self.child is None or self.child.poll() is not None or self.master_fd is None:
                raise RuntimeError("bootstrap is no longer running; reauthentication required")
            self.status = "active"
            self.starting_deadline_ms = None
            self.error = None
            self.persist()

    def _send(self, command: str, timeout_ms: int) -> str:
        if len(command) > 16 * 1024:
            raise ValueError("probe command is too long")
        if not self.allowed_probe_prefixes:
            raise PermissionError("no probe command prefixes configured")
        command_text = command.strip()
        if any(token in command_text for token in (";", "|", "&", ">", "<", "`", "$", "(", ")")):
            raise PermissionError("probe command contains shell metacharacters")
        if any(ord(character) < 0x20 or ord(character) == 0x7F for character in command_text):
            raise PermissionError("probe command contains control characters")
        if not any(
            command_text == prefix or command_text.startswith(f"{prefix} ")
            for prefix in self.allowed_probe_prefixes
        ):
            raise PermissionError("probe command is outside the declared allowlist")
        with self.output_condition:
            if self.status != "active" or self.master_fd is None:
                raise RuntimeError("connection lease is not active; explicit reauthentication required")
            marker = f"__PI_ML_LEASE_{uuid.uuid4().hex}__"
            # Split the marker across printf arguments so an interactive shell's
            # command echo cannot contain the complete marker before execution.
            split_at = len(marker) // 2
            marker_left = marker[:split_at]
            marker_right = marker[split_at:]
            payload = (
                f"{command}; printf '\\n%s%s\\n' '{marker_left}' '{marker_right}'\n"
            ).encode("utf-8")
            os.write(self.master_fd, payload)
            deadline = time.monotonic() + timeout_ms / 1000
            marker_bytes = marker.encode("utf-8")
            while True:
                index = self.output.find(marker_bytes)
                if index >= 0:
                    result = bytes(self.output[:index])
                    del self.output[: index + len(marker_bytes)]
                    return result.decode("utf-8", errors="replace")
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError("probe command timed out")
                self.output_condition.wait(timeout=min(remaining, 0.25))
                if self.status != "active":
                    raise RuntimeError("connection lease became unavailable")

    def handle(self, request: dict[str, Any]) -> dict[str, Any]:
        action = request.get("action")
        self.check_expiry()
        if action == "status":
            return {"ok": True, "state": self.state()}
        if action == "probe":
            command = request.get("command")
            if not isinstance(command, str) or not command.strip():
                raise ValueError("probe command is required")
            timeout_ms = request.get("timeoutMs", self.probe_timeout_ms)
            if (
                isinstance(timeout_ms, bool)
                or not isinstance(timeout_ms, int)
                or timeout_ms <= 0
                or timeout_ms > self.probe_timeout_ms
            ):
                raise ValueError("probe timeout must be a positive integer within the daemon limit")
            result = self._send(command, timeout_ms)
            return {"ok": True, "output": result, "state": self.state()}
        if action == "stop":
            self.stop()
            return {"ok": True, "state": self.state()}
        if action == "reauth":
            self.reauthenticate()
            return {"ok": True, "state": self.state()}
        if action == "ready":
            self.mark_ready()
            return {"ok": True, "state": self.state()}
        raise ValueError("unsupported lease action")


def serve(daemon: LeaseDaemon) -> None:
    daemon.socket_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        daemon.socket_path.unlink()
    except FileNotFoundError:
        pass
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(str(daemon.socket_path))
    os.chmod(daemon.socket_path, 0o600)
    server.listen(16)
    server.settimeout(0.25)
    try:
        daemon.start()
        while not STOP:
            daemon.check_expiry()
            try:
                connection, _ = server.accept()
            except socket.timeout:
                continue
            with connection:
                connection.settimeout(daemon.probe_timeout_ms / 1000 + 2)
                try:
                    chunks = []
                    while True:
                        chunk = connection.recv(64 * 1024)
                        if not chunk:
                            break
                        chunks.append(chunk)
                        if b"\n" in chunk:
                            break
                    request = json.loads(b"".join(chunks).split(b"\n", 1)[0])
                    response = daemon.handle(request)
                except (OSError, ValueError, RuntimeError, TimeoutError, json.JSONDecodeError) as error:
                    response = {"ok": False, "error": str(error), "state": daemon.state()}
                connection.sendall((json.dumps(response, ensure_ascii=False) + "\n").encode("utf-8"))
    finally:
        daemon.stop()
        server.close()
        try:
            daemon.socket_path.unlink()
        except FileNotFoundError:
            pass


def stop_signal(_signum: int, _frame: Any) -> None:
    global STOP
    STOP = True


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--socket", required=True, type=Path)
    parser.add_argument("--state", required=True, type=Path)
    parser.add_argument("--ttl-seconds", type=float, default=172800)
    parser.add_argument("--startup-timeout-seconds", type=float, default=900)
    parser.add_argument("--probe-timeout-seconds", type=float, default=30)
    parser.add_argument(
        "--allowed-probe-prefix",
        action="append",
        default=[],
        help="allowed probe command prefix; repeat for multiple status commands",
    )
    parser.add_argument(
        "--command",
        required=True,
        nargs=argparse.REMAINDER,
        help="bootstrap command argv; must be the final argument group",
    )
    args = parser.parse_args()
    if not args.command:
        raise ValueError("bootstrap command is required")
    if args.ttl_seconds <= 0 or args.startup_timeout_seconds <= 0 or args.probe_timeout_seconds <= 0:
        raise ValueError("lease TTL, startup timeout, and probe timeout must be positive")
    signal.signal(signal.SIGTERM, stop_signal)
    signal.signal(signal.SIGINT, stop_signal)
    serve(LeaseDaemon(args))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError) as error:
        print(f"ml-pty-lease: {error}", flush=True)
        raise SystemExit(2)
