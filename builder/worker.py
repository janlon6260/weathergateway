"""Fixed-source ESP-IDF worker. No network service, Docker socket or signing keys.

Only /jobs is shared with control. The firmware template and dependencies are baked
into the image. A single compiler runs at a time; requests cannot supply commands.
"""
import base64
import json
import os
import pathlib
import re
import shutil
import signal
import subprocess
import threading
import time

os.umask(0o077)
JOBS = pathlib.Path(os.environ.get("WG_BUILD_JOBS", "/jobs")).resolve()
WORK = pathlib.Path(os.environ.get("WG_BUILD_WORK", "/workspace")).resolve()
TEMPLATE = pathlib.Path(os.environ.get("WG_FIRMWARE_TEMPLATE", "/opt/wg-firmware")).resolve()
ENVIRONMENT = os.environ.get("WG_ENVIRONMENT", "production")
UUID = re.compile(r"^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$")
stop = threading.Event()
active = None
STARTED_AT = int(time.time() * 1000)


def terminate_compiler():
    if not active or active.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(["taskkill", "/PID", str(active.pid), "/T", "/F"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
    else:
        os.killpg(active.pid, signal.SIGTERM)
        try:
            active.wait(10)
        except subprocess.TimeoutExpired:
            os.killpg(active.pid, signal.SIGKILL)


def atomic(path, value):
    temporary = path.with_name(path.name + ".worker-tmp")
    temporary.write_text(json.dumps(value), encoding="utf-8")
    for attempt in range(10):
        try:
            os.replace(temporary, path)
            return
        except PermissionError:
            # Windows virus scanners / readers can briefly hold a replacement open.
            if attempt == 9:
                raise
            time.sleep(0.05)


def heartbeat():
    while not stop.is_set():
        atomic(JOBS / "worker.json", {"at": int(time.time() * 1000), "startedAt": STARTED_AT, "environment": ENVIRONMENT})
        stop.wait(3)


def finish(*_args):
    stop.set()
    if active and active.poll() is None:
        terminate_compiler()


def build(directory):
    global active
    request = json.loads((directory / "request.json").read_text(encoding="utf-8"))
    if request.get("format") != 1 or request.get("buildId") != directory.name or request.get("environment") != ENVIRONMENT:
        raise ValueError("Wrong build identity")
    files = request.get("files", {})
    if set(files) != {"provisioning.h", "device.key", "device.pem", "ca.pem"} or any(not isinstance(v, str) or len(v) > 20000 for v in files.values()):
        raise ValueError("Invalid provisioning files")
    project = WORK / "project"
    if not project.exists():
        shutil.copytree(TEMPLATE, project)
    # Apply the image's exact source on every job, keeping only the local build cache.
    shutil.copytree(TEMPLATE, project, dirs_exist_ok=True)
    for name, body in files.items():
        (project / "main" / name).write_text(body, encoding="utf-8")
    secrets = [line for name, body in files.items() if name.endswith(".key") for line in body.splitlines() if line]
    for line in files["provisioning.h"].splitlines():
        if line.startswith("#define WG_WIFI_PASSWORD "):
            value = json.loads(line.split(" ", 2)[2])
            secrets.extend([value, json.dumps(value)[1:-1]])

    def redact(text):
        for secret in secrets:
            if secret:
                text = text.replace(secret, "[skjult]")
        return re.sub(r"\x1b\[[0-9;]*[A-Za-z]", "", text)

    log = "Starter ESP-IDF-kompilering på serveren …\n"
    atomic(directory / "progress.json", {"log": log})
    python = os.environ.get("IDF_PYTHON_ENV_PATH")
    python = str(pathlib.Path(python) / ("Scripts/python.exe" if os.name == "nt" else "bin/python")) if python else os.sys.executable
    command = [python, str(pathlib.Path(os.environ["IDF_PATH"]) / "tools/idf.py"), "--no-ccache", "-B", str(WORK / "build"), "build"]
    started = time.monotonic()
    # Write compiler output privately, then publish a bounded, redacted tail.
    raw_log = WORK / "compiler.log"
    try:
        with raw_log.open("w", encoding="utf-8") as output:
            active = subprocess.Popen(command, cwd=project, stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT, shell=False,
                                      creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
                                      start_new_session=os.name != "nt")
            while active.poll() is None:
                if stop.is_set() or (directory / "cancel").exists() or time.monotonic() - started > 25 * 60:
                    terminate_compiler()
                    raise RuntimeError("Build cancelled or timed out")
                with raw_log.open("rb") as stream:
                    stream.seek(max(0, raw_log.stat().st_size - 30000))
                    log = redact(stream.read().decode("utf-8", errors="replace"))[-16000:]
                atomic(directory / "progress.json", {"log": log})
                stop.wait(1)
        with raw_log.open("rb") as stream:
            stream.seek(max(0, raw_log.stat().st_size - 30000))
            log = redact(stream.read().decode("utf-8", errors="replace"))[-16000:]
        atomic(directory / "progress.json", {"log": log})
        if active.returncode:
            raise RuntimeError("ESP-IDF build failed")
        build_root = (WORK / "build").resolve()
        args = json.loads((build_root / "flasher_args.json").read_text())
        sdk = json.loads((build_root / "config/sdkconfig.json").read_text())
        if any(sdk.get(key) for key in ["SECURE_BOOT", "SECURE_BOOT_V2_ENABLED", "SECURE_FLASH_ENC_ENABLED", "NVS_ENCRYPTION"]) or args["extra_esptool_args"]["chip"] != "esp32" or args["flash_settings"]["flash_size"] != "4MB":
            raise ValueError("Unsupported flash security profile")
        images = []
        for address, maximum in [("0x1000", 0x7000), ("0x8000", 0x1000), ("0xf000", 0x2000), ("0x20000", 0x180000)]:
            path = (build_root / args["flash_files"][address]).resolve()
            if not path.is_relative_to(build_root) or not 0 < path.stat().st_size <= maximum:
                raise ValueError("Invalid flash layout")
            images.append(base64.b64encode(path.read_bytes()).decode("ascii"))
        atomic(directory / "result.json", {"buildId": directory.name, "environment": ENVIRONMENT, "images": images})
    except Exception as error:
        atomic(directory / "progress.json", {"log": (log + "\n" + redact(type(error).__name__ + ": " + str(error)))[-16000:]})
        raise
    finally:
        terminate_compiler()
        active = None
        for name in files:
            (project / "main" / name).unlink(missing_ok=True)
        raw_log.unlink(missing_ok=True)


def main():
    if ENVIRONMENT not in {"production", "development", "test"}:
        raise ValueError("Invalid environment")
    JOBS.mkdir(parents=True, exist_ok=True)
    WORK.mkdir(parents=True, exist_ok=True)
    threading.Thread(target=heartbeat, daemon=True).start()
    signal.signal(signal.SIGTERM, finish)
    signal.signal(signal.SIGINT, finish)
    while not stop.is_set():
        for directory in sorted(JOBS.iterdir(), key=lambda p: p.name):
            if not UUID.fullmatch(directory.name) or directory.is_symlink() or not directory.is_dir():
                continue
            if not (directory / "request.json").is_file() or (directory / "result.json").exists() or (directory / "cancel").exists():
                continue
            try:
                build(directory)
            except Exception:
                if not (directory / "cancel").exists():
                    atomic(directory / "result.json", {"error": "build_failed"})
            finally:
                if directory.is_dir():
                    atomic(directory / "finished.json", {"at": int(time.time() * 1000)})
            if stop.is_set():
                break
        stop.wait(1)


if __name__ == "__main__":
    main()
