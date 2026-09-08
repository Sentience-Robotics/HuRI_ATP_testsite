"""Launches and supervises a HuRI (Ray Serve) process from this website's
backend, so a tester can pick a config from the HuRI submodule and bring an
instance up/down without a terminal — covering HuRI/ATP.xlsx F1 ("Configure
HuRI") and giving F2-F11 something real to point a client at.

Single-instance by design: HuRI binds fixed local ports (Ray Serve's HTTP
ingress and the Ray dashboard), so running two at once would just collide.
``HuriLauncher`` therefore tracks exactly one subprocess, started with
``serve run <config path>`` (cwd'd into the HuRI checkout, matching the usage
comment at the top of HuRI/config/huri.yaml) and torn down with SIGINT (the
same as Ctrl-C, which `serve run` handles as a controlled shutdown) followed
by ``ray stop`` to reclaim the local Ray head it may have started. The config
path can point at either a bare ``HuRI/config/huri*.yaml`` or one of its
per-ATP-feature copies under the website's own ``presets/`` folder (see
``presets/README.md`` and :meth:`HuriLauncher._discover_configs`).

This spawns real local processes on the machine running the backend, so every
route that touches it must sit behind auth (see main.py's ``_require_auth``)
— treat it as a trusted-operator control panel, not a public API.
"""

import asyncio
import logging
import os
import signal
import time
from collections import deque
from pathlib import Path
from typing import Any, Deque, Dict, List, Optional, Tuple

import httpx

logger = logging.getLogger(__name__)

_LOG_MAXLEN = 2000
_READY_POLL_INTERVAL = 1.0
_READY_TIMEOUT = 90.0
_STOP_GRACE_PERIOD = 20.0


class AlreadyRunningError(RuntimeError):
    pass


class NotRunningError(RuntimeError):
    pass


class UnknownConfigError(ValueError):
    pass


class HuriLauncher:
    """Owns the lifecycle of one ``serve run`` subprocess.

    Not safe to share across multiple backend worker processes (state is
    in-memory) — fine for this site, which runs the backend as a single
    uvicorn process (see backend/Dockerfile's CMD).
    """

    def __init__(self, repo_path: Path, probe_url: str, presets_dir: Optional[Path] = None):
        self.repo_path = repo_path
        self.config_dir = repo_path / "config"
        # Per-ATP-feature copies of a huri*.yaml config (see presets/README.md)
        # so a tester can pick "F1/huri_cpu.yaml" straight off the sheet
        # instead of cross-referencing which bare config it happens to be.
        self.presets_dir = presets_dir
        # Where readiness is probed (HuRI's own HTTP ingress, not the Ray
        # dashboard) — any response at all means the app is up and serving.
        self.probe_url = probe_url
        self.dashboard_url = os.environ.get(
            "HURI_DASHBOARD_URL", "http://127.0.0.1:8265/"
        )
        self.serve_bin = os.environ.get("HURI_SERVE_BIN", "serve")
        self.ray_bin = os.environ.get("HURI_RAY_BIN", "ray")

        self._process: Optional[asyncio.subprocess.Process] = None
        self._config_name: Optional[str] = None
        self._status = "stopped"  # stopped | starting | running | stopping | crashed
        self._started_at: Optional[float] = None
        self._exit_code: Optional[int] = None
        self._last_error: Optional[str] = None
        self._log_lines: Deque[Tuple[float, str]] = deque(maxlen=_LOG_MAXLEN)
        self._log_task: Optional[asyncio.Task] = None
        self._reap_task: Optional[asyncio.Task] = None
        self._ready_task: Optional[asyncio.Task] = None
        self._lock = asyncio.Lock()

    def _discover_configs(self) -> Dict[str, Path]:
        """Every launchable server-side HuRI config, keyed by what the
        dropdown/API shows: bare ``config/huri*.yaml`` files under the plain
        name (``"huri.yaml"``), plus any per-ATP-feature copies under
        ``presets/`` keyed by their path relative to it (``"F1/huri.yaml"``)
        — see presets/README.md. (``client_*.yaml`` files are the *other*
        kind of config, for a client connecting to an already-running HuRI,
        and aren't launchable here.)"""
        configs: Dict[str, Path] = {}
        if self.config_dir.is_dir():
            for path in self.config_dir.glob("huri*.yaml"):
                configs[path.name] = path
        if self.presets_dir is not None and self.presets_dir.is_dir():
            for path in self.presets_dir.rglob("huri*.yaml"):
                key = path.relative_to(self.presets_dir).as_posix()
                configs[key] = path
        return configs

    def list_configs(self) -> List[str]:
        """Server-side HuRI configs available to launch (see
        :meth:`_discover_configs`)."""
        return sorted(self._discover_configs())

    def status(self) -> Dict[str, Any]:
        pid = self._process.pid if self._process and self._process.returncode is None else None
        return {
            "status": self._status,
            "config": self._config_name,
            "pid": pid,
            "started_at": self._started_at,
            "uptime_seconds": (time.time() - self._started_at) if self._started_at and pid else None,
            "dashboard_url": self.dashboard_url,
            "exit_code": self._exit_code,
            "last_error": self._last_error,
        }

    def logs(self, tail: int = 200) -> List[str]:
        lines = list(self._log_lines)[-max(tail, 0):]
        return [f"[{time.strftime('%H:%M:%S', time.localtime(ts))}] {line}" for ts, line in lines]

    async def start(self, config_name: str) -> None:
        async with self._lock:
            if self._status in ("starting", "running", "stopping"):
                raise AlreadyRunningError(
                    f"HuRI is already {self._status} (config={self._config_name})."
                )
            configs = self._discover_configs()
            if config_name not in configs:
                raise UnknownConfigError(
                    f"Unknown config {config_name!r}; must be one of {sorted(configs)}."
                )
            config_path = configs[config_name]

            self._log_lines.clear()
            self._exit_code = None
            self._last_error = None
            self._config_name = config_name
            self._status = "starting"
            self._started_at = time.time()

            try:
                self._process = await asyncio.create_subprocess_exec(
                    self.serve_bin,
                    "run",
                    str(config_path),
                    cwd=str(self.repo_path),
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.STDOUT,
                )
            except FileNotFoundError as exc:
                self._status = "crashed"
                self._last_error = (
                    f"Could not exec {self.serve_bin!r}: {exc}. Is HuRI's Python "
                    "environment (ray[serve]) active for this backend process? "
                    "Override with the HURI_SERVE_BIN env var."
                )
                raise RuntimeError(self._last_error) from exc

            self._log_task = asyncio.create_task(self._read_logs())
            self._reap_task = asyncio.create_task(self._reap())
            self._ready_task = asyncio.create_task(self._wait_ready())

    async def stop(self) -> None:
        async with self._lock:
            if self._status not in ("starting", "running"):
                raise NotRunningError(f"HuRI is not running (status={self._status}).")
            self._status = "stopping"
            proc = self._process

        assert proc is not None
        try:
            proc.send_signal(signal.SIGINT)  # same as Ctrl-C: serve run shuts down cleanly
        except ProcessLookupError:
            pass

        waited = 0.0
        while proc.returncode is None and waited < _STOP_GRACE_PERIOD:
            await asyncio.sleep(0.5)
            waited += 0.5

        if proc.returncode is None:
            logger.warning("HuRI did not exit within %.0fs of SIGINT; killing.", _STOP_GRACE_PERIOD)
            proc.kill()
            await proc.wait()

        # Best-effort cleanup of any local Ray head `serve run` autostarted —
        # harmless if none is running.
        try:
            cleanup = await asyncio.create_subprocess_exec(
                self.ray_bin, "stop",
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
            await asyncio.wait_for(cleanup.wait(), timeout=15)
        except (FileNotFoundError, asyncio.TimeoutError) as exc:
            logger.warning("`%s stop` cleanup skipped: %s", self.ray_bin, exc)

    async def _read_logs(self) -> None:
        assert self._process is not None and self._process.stdout is not None
        try:
            async for raw_line in self._process.stdout:
                line = raw_line.decode(errors="replace").rstrip("\n")
                self._log_lines.append((time.time(), line))
        except Exception:
            logger.exception("HuRI log reader crashed")

    async def _wait_ready(self) -> None:
        # Probing self.probe_url (HuRI's bare HTTP origin) isn't enough: Ray
        # Serve's proxy binds and answers *before* the actual app finishes
        # deploying, responding "Path '/' not found... route table is not
        # populated yet" — a real HTTP response, so the old plain
        # `client.get(self.probe_url)` treated that as ready and declared
        # "running" while the app (still loading STT/RAG/etc. models) would
        # reject every session. Probe a route that only 200s once the app
        # itself is serving (see HuRI/src/core/huri.py's "/modules").
        deadline = time.time() + _READY_TIMEOUT
        async with httpx.AsyncClient(timeout=2.0) as client:
            while time.time() < deadline:
                if self._status != "starting":
                    return  # already resolved (crashed, or stop requested)
                try:
                    resp = await client.get(f"{self.probe_url}/modules")
                    resp.raise_for_status()
                    self._status = "running"
                    return
                except Exception:
                    pass
                await asyncio.sleep(_READY_POLL_INTERVAL)
        if self._status == "starting":
            self._last_error = (
                f"HuRI did not answer at {self.probe_url} within {_READY_TIMEOUT:.0f}s "
                "(still starting, or misconfigured — check logs)."
            )
            logger.warning(self._last_error)

    async def _reap(self) -> None:
        assert self._process is not None
        returncode = await self._process.wait()
        self._exit_code = returncode
        if self._status == "stopping":
            self._status = "stopped"
        else:
            self._status = "crashed"
            if not self._last_error:
                self._last_error = f"HuRI exited unexpectedly (code {returncode}); see logs."
            logger.warning("HuRI process exited unexpectedly (code %s)", returncode)
