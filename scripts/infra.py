#!/usr/bin/env python3
"""管理本项目独立的 ARM64 开发依赖；不切换全局 Docker context。"""

import argparse
import json
import os
from pathlib import Path
import platform
import secrets
import shutil
import stat
import subprocess
import sys
from datetime import datetime, timezone


ROOT = Path(__file__).resolve().parents[1]
SECRET_DIR = ROOT / ".local" / "infra"
CONTEXT = "colima-data-agent"
PROJECT = "data-agent"
SECRET_FILES = (
    "mysql-root-password", "mysql-app-password", "mysql-root-client.cnf",
    "minio-root-user", "minio-root-password", "milvus-root-password",
    "milvus-user.yaml",
)


def compose_args(*args: str) -> list[str]:
    # 独立 Compose CLI；显式忽略项目 .env，避免读取已有配置或凭据。
    return ["docker-compose", "--env-file", "/dev/null", "--project-directory", str(ROOT),
            "--project-name", PROJECT, "--file", str(ROOT / "compose.yaml"), *args]


def docker_args(*args: str) -> list[str]:
    return ["docker", "--context", CONTEXT, *args]


def tool_env() -> dict[str, str]:
    env = os.environ.copy()
    for key in ("DOCKER_HOST", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH", "DOCKER_TLS",
                "COMPOSE_FILE", "COMPOSE_PROJECT_NAME", "COMPOSE_PROFILES"):
        env.pop(key, None)
    env["DOCKER_CONTEXT"] = CONTEXT
    env["COMPOSE_ANSI"] = "never"
    return env


def run(args: list[str], *, capture: bool = False, input_text: str | None = None,
        timeout: int = 600) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, cwd=ROOT, env=tool_env(), text=True, input=input_text,
                          capture_output=capture, check=True, timeout=timeout)


def write_private(name: str, value: str) -> None:
    descriptor = os.open(SECRET_DIR / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w") as output:
        output.write(value)


def validate_secrets() -> None:
    marker = SECRET_DIR / "prepared.json"
    if not marker.is_file():
        raise RuntimeError("缺少本项目秘密生成记录。先运行 python3 scripts/infra.py prepare。")
    metadata = json.loads(marker.read_text())
    if metadata.get("schema") != 1 or metadata.get("files") != list(SECRET_FILES):
        raise RuntimeError("本项目秘密生成记录格式不符；保留原文件，需人工核对。")
    for name in (*SECRET_FILES, "prepared.json"):
        file = SECRET_DIR / name
        if file.is_symlink() or not file.is_file() or stat.S_IMODE(file.stat().st_mode) != 0o600:
            raise RuntimeError(f"本项目秘密文件缺失或权限不符（要求 0600）：{name}")


def prepare() -> None:
    if SECRET_DIR.is_symlink():
        raise RuntimeError("秘密目录不能是符号链接。")
    SECRET_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
    SECRET_DIR.chmod(0o700)
    if any(SECRET_DIR.iterdir()):
        validate_secrets()
        print("本项目已有开发秘密保持不变（权限已核对）。")
        return
    root_password = secrets.token_hex(32)
    app_password = secrets.token_hex(32)
    minio_user = "dataagent" + secrets.token_hex(8)
    minio_password = secrets.token_hex(32)
    milvus_password = secrets.token_hex(32)
    values = {
        "mysql-root-password": root_password + "\n",
        "mysql-app-password": app_password + "\n",
        "mysql-root-client.cnf": f"[client]\nuser=root\npassword={root_password}\nprotocol=socket\n",
        "minio-root-user": minio_user + "\n",
        "minio-root-password": minio_password + "\n",
        "milvus-root-password": milvus_password + "\n",
        "milvus-user.yaml": (
            "minio:\n"
            f'  accessKeyID: "{minio_user}"\n'
            f'  secretAccessKey: "{minio_password}"\n'
            "common:\n  security:\n    authorizationEnabled: true\n"
            f'    defaultRootPassword: "{milvus_password}"\n'
        ),
    }
    # 独占创建；中途失败也不自动更换任何密码，避免已有卷与密码失配。
    for name, value in values.items():
        write_private(name, value)
    write_private("prepared.json", json.dumps({
        "schema": 1, "created_at": datetime.now(timezone.utc).isoformat(),
        "files": list(SECRET_FILES),
    }, indent=2) + "\n")
    validate_secrets()
    print("已生成本项目随机开发秘密（.local/infra，全部 0600，不输出内容）。")


def start() -> None:
    if platform.system() != "Darwin" or platform.machine() not in ("arm64", "aarch64"):
        raise RuntimeError("当前启动配置面向 macOS ARM64，未配置其他平台或 x86 模拟。")
    for name in ("colima", "docker", "docker-compose"):
        if shutil.which(name) is None:
            raise RuntimeError(f"缺少命令：{name}")
    prepare()
    run(["colima", "start", "--profile", PROJECT, "--cpus", "4", "--memory", "6", "--disk", "30",
         "--mount", str(ROOT / "infra"), "--mount", str(SECRET_DIR),
         "--activate=false", "--ssh-config=false", "--binfmt=false"], timeout=900)
    run(compose_args("config", "--quiet"))
    run(compose_args("up", "--detach", "--pull", "missing", "--quiet-pull",
                     "--wait", "--wait-timeout", "240"), timeout=2100)
    print("本项目依赖已启动；运行 python3 scripts/check-infra.py 完成功能烟测。")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("prepare", "up", "status", "stop", "down", "vm-stop"))
    command = parser.parse_args().command
    try:
        if command == "prepare":
            prepare()
        elif command == "up":
            start()
        elif command == "status":
            run(compose_args("ps", "--all"))
        elif command == "stop":
            run(compose_args("stop"))
            print("仅停止本项目容器；命名卷和开发秘密保留。")
        elif command == "down":
            run(compose_args("down"))
            print("仅移除本项目容器和网络；命名卷和开发秘密保留。")
        elif command == "vm-stop":
            run(compose_args("stop"))
            run(["colima", "stop", "--profile", PROJECT])
            print("本项目容器及独立 VM 已停止；命名卷和开发秘密保留。")
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        # 不回显命令输出或配置正文；CLI 自身只执行无秘密参数的命令。
        print(f"基础设施操作未完成：{type(error).__name__}: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
