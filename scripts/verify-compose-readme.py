#!/usr/bin/env python3
from __future__ import annotations

import difflib
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
COMPOSE = ROOT / "docker-compose.yml"
README = ROOT / "README.md"
HEADING = "### 手动创建 `docker-compose.yml`（完整内容）"


def main() -> None:
    compose = COMPOSE.read_text(encoding="utf-8").strip()
    readme = README.read_text(encoding="utf-8")
    section = readme.split(HEADING, 1)[1]
    documented = section.split("```yaml", 1)[1].split("```", 1)[0].strip()

    if compose != documented:
        diff = "\n".join(
            difflib.unified_diff(
                documented.splitlines(),
                compose.splitlines(),
                fromfile="README compose block",
                tofile="docker-compose.yml",
                lineterm="",
            )
        )
        raise SystemExit(f"README 中的 Compose 与根目录文件不一致：\n{diff}")

    required = [
        'PUBLIC_ORIGIN: "${PUBLIC_ORIGIN:-}"',
        '"0.0.0.0:${HTTP_PORT:-38100}:80"',
        'restart: "on-failure:5"',
    ]
    for value in required:
        if value not in compose:
            raise SystemExit(f"Compose 缺少预期配置：{value}")

    if "185.99.135.224" in compose:
        raise SystemExit("Compose 不应绑定某一台服务器的公网 IP")

    print("Compose、README、默认端口与无固定 IP 配置一致")


if __name__ == "__main__":
    main()
