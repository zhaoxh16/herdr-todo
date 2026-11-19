#!/usr/bin/env python3
"""把 todo 面板插进一份独立的布局文件（克隆自 App 自带的 main）。

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
MOD = "herdr-todo"
BLOCK_ID = "todo-block"


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

    # 待办不是另起一列，而是接进 App 自带的右侧面板 stack（panel-body）。
    # 这样它和 Files/Changes 完全同构：同一个显隐开关、同一份宽度、同一套
    # 「当前显示哪个面板」的语义。自建一列会和原生面板并排，关掉一个还剩另一个。
    stack = find(layout, "panel-body")
    if stack is None:
        print("main 布局结构变了：找不到 panel-body stack", file=sys.stderr)
        return 1

    children = stack.setdefault("children", [])
    existing = next((c for c in children if c.get("id") == BLOCK_ID), None)
    if existing is None:
        children.append({"id": BLOCK_ID, "type": "block", "content": {"mod": MOD}})
    else:
        # id 撞上了但内容指向别的 mod（用户自己改过 main，或另一个工具占了这个 id）：
        # 直接设 active 会让布局加载一个不相干的 mod。
        existing.setdefault("content", {})["mod"] = MOD

    # 默认显示 Todo。这份布局的名字就是 Herdr + Todo，第一次按 ctrl-alt-t
    # 却弹出 Files 会让人以为快捷键绑错了；每个 space 之后的显隐选择由
    # tabs mod 记在 localStorage 里，这里只决定「还没有记忆时」的那一次。
    stack["active"] = BLOCK_ID

    # tab bar 换成带 Todo 按钮的克隆件；它和 Files/Changes 的按钮并排。
    tabs_block = find(layout, "tabs")
    if tabs_block is None:
        print("main 布局结构变了：找不到 tabs 块", file=sys.stderr)
        return 1
    tabs_block.setdefault("content", {})["mod"] = "tabs-todo"

    layout["id"] = "herdr-todo-root"
    # 自带 main 没有 title；给这份独立的布局一个可辨识的名字。
    layout["title"] = "Herdr + Todo"

    # 这份布局是用户的文件：他可能调过面板宽度或默认面板。重跑安装会把它
    # 恢复成默认值，所以覆盖前必须先备份（README 承诺「被覆盖的文件都会先备份」）。
    if os.path.isfile(DST):
        stamp = time.strftime("%Y%m%d%H%M%S") + f"-{int(time.time() * 1000) % 1000:03d}"
        backup = f"{DST}.bak-{stamp}"
        shutil.copy2(DST, backup)
        print(f"已备份 {os.path.basename(DST)} → {os.path.basename(backup)}")

    tmp = os.path.join(os.path.dirname(DST), f".{os.path.basename(DST)}.tmp")
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(layout, fh, indent=1, ensure_ascii=False)
    os.replace(tmp, DST)
    print(f"已写入 {DST}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
