#!/usr/bin/env python3
"""把待办接进一份独立的布局文件（克隆自 App 自带的 main）。

待办列表住在左侧 Spaces 侧栏里，所以这里只做一件事：把侧栏的 `spaces` 块
指向本项目的克隆件 `spaces-todo`（它在原生 Spaces 之上追加每个 space 的待办行）。
右侧 panel-body 与 tab bar 都保持 App 原样——待办不再占用右侧面板。

不改 main.json 本身：Herdr 每次启动都会用自带版本覆盖 main，
所以必须另存一个布局，用户的改动才能留住。
"""

import json
import os
import shutil
import sys
import time

APP_HOME = os.environ.get("HERDR_APP_HOME") or os.path.expanduser("~/.config/herdr-app")
SRC = os.path.join(APP_HOME, "layouts", "main.json")
DST = os.path.join(APP_HOME, "layouts", "herdr-todo.json")
MOD = "spaces-todo"
AGENTS_MOD = "agents-todo"


def find(node, node_id):
    if isinstance(node, dict):
        if node.get("id") == node_id:
            return node
        for child in node.get("children", []):
            hit = find(child, node_id)
            if hit:
                return hit
    return None


def main():
    if not os.path.isfile(SRC):
        print(f"找不到 App 的 main 布局：{SRC}", file=sys.stderr)
        return 1

    with open(SRC, encoding="utf-8") as fh:
        layout = json.load(fh)

    # 侧栏的 spaces 块：换成带待办行的克隆件。
    spaces_block = find(layout, "spaces")
    if spaces_block is None:
        print("main 布局结构变了：找不到侧栏 spaces 块", file=sys.stderr)
        return 1
    spaces_block.setdefault("content", {})["mod"] = MOD

    # Agents 栏同理：它是 App 自带 mod，要显示待办必须换成克隆件。
    # 找不到不算失败——用户可能自己删掉了 Agents 块，那种情况下没有地方
    # 显示 agent 待办，但不该让整个安装失败。
    agents_block = find(layout, "agents")
    if agents_block is not None:
        agents_block.setdefault("content", {})["mod"] = AGENTS_MOD

    # App 自带 main 没有 title；给这份独立的布局一个可辨识的名字。
    layout["id"] = "herdr-todo-root"
    layout["title"] = "Herdr + Todo"

    # 这份布局是用户的文件：他可能调过面板宽度或默认面板。重跑安装会把它
    # 恢复成默认值，所以覆盖前必须先备份（README 承诺「被覆盖的文件都会先备份」）。
    if os.path.isfile(DST):
        stamp = time.strftime("%Y%m%d%H%M%S") + f"-{int(time.time() * 1000) % 1000:03d}"
        backup = f"{DST}.bak-{stamp}"
        shutil.copy2(DST, backup)
        print(f"已备份 {os.path.basename(DST)} → {os.path.basename(backup)}")

    # 布局文件可能是 dotfiles 里的符号链接（和 keys.json 一样的用法）：
    # 写到它指向的真实文件，否则 os.replace 会把链接换成普通文件，
    # dotfiles 里那份永远停在旧内容，用户之后的编辑也写不到它上面。
    target = os.path.realpath(DST) if os.path.islink(DST) else DST
    # 临时文件必须和目标同目录：跨文件系统 rename 会 EXDEV（iCloud、挂载卷）。
    tmp = os.path.join(os.path.dirname(target), f".{os.path.basename(target)}.tmp")
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(layout, fh, indent=1, ensure_ascii=False)
    if os.path.exists(target):
        shutil.copymode(target, tmp)
    os.replace(tmp, target)
    print(f"已写入 {target}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
