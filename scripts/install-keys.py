#!/usr/bin/env python3
"""把待办面板的快捷键写进 keys.json。

Herdr 的「Keyboard shortcuts」就是 keys.json，所以这里不自己发明配置：
直接写标准绑定，之后用户随时可以在 App 里改，或再跑一次脚本恢复默认。

两条绑定走的是 App 原生命令，不依赖 mod 常驻：
  - 展开/收起侧栏：layout.toggle（列被拖窄或被隐藏都能一键切换）
  - 快速记录：mod.open（再按一次关闭，等价于弹窗的开关）
"""

import errno
import json
import os
import shutil
import sys
import time

APP_HOME = os.environ.get("HERDR_APP_HOME") or os.path.expanduser("~/.config/herdr-app")
KEYS = os.path.join(APP_HOME, "keys.json")
PANEL_COLUMN_ID = "panel"
MOD_NAME = "herdr-todo"

# Herdr 按分区解析：layout:<name> 只在那个布局显示时生效，优先级高于 global。
# 绑在 global，因为右侧面板在所有布局里都是同一个节点；toggle 会把
# Files/Changes/Todo 所在的整列一起收起，和点 tab bar 上的按钮等价。
DEFAULTS = {
    "global": {
        "ctrl-alt-t": {"command": "layout.toggle", "args": {"id": PANEL_COLUMN_ID}},
        "ctrl-alt-n": {"command": "mod.open", "args": {"name": MOD_NAME}},
    }
}


def main():
    if not os.path.isfile(KEYS):
        print(f"找不到 {KEYS}", file=sys.stderr)
        return 1

    with open(KEYS, encoding="utf-8") as fh:
        try:
            keys = json.load(fh)
        except json.JSONDecodeError as e:
            print(f"{KEYS} 不是合法 JSON：{e}", file=sys.stderr)
            return 1

    # 形状不对时给一句能读懂的话，而不是裸露的 TypeError 栈。
    if not isinstance(keys, dict):
        print(f"{KEYS} 顶层必须是对象", file=sys.stderr)
        return 1
    for name, section in list(keys.items()):
        if not isinstance(section, dict):
            print(f"{KEYS} 的 {name} 分区必须是对象（快捷键 → 动作）", file=sys.stderr)
            return 1

    changed = []

    # 清理旧版本留下的绑定：同一个命令绑到了已经不存在的节点（例如早期自建
    # 的 todo-column）。分区优先级高于 global，残留项会让快捷键指错目标。
    for section in list(keys):
        for combo in list(keys[section]):
            action = keys[section][combo]
            if isinstance(action, dict) and action.get("args", {}).get("id") == "todo-column":
                del keys[section][combo]
                changed.append(f"清理 {section} {combo}：指向已删除的 todo-column")
        if not keys[section]:
            del keys[section]

    # 先补 global，再清理分区副本。顺序不能反：global 上的键可能已被别的
    # 动作占用（这时会跳过），若先删了分区里那份可用的绑定，用户就一个能用的
    # 快捷键都不剩，而报告里还会写「与 global 默认绑定重复」——那是假话。
    landed = set()
    skipped = set()
    for section, binds in DEFAULTS.items():
        target = keys.setdefault(section, {})
        for combo, action in binds.items():
            # 已经绑了同一个命令就跳过；被别的动作占用则汇报，不静默覆盖用户的按键。
            existing = target.get(combo)
            if existing == action:
                landed.add(combo)
                continue
            if existing is not None:
                skipped.add(combo)
                changed.append(f"跳过 {section} {combo}：已被 {existing} 占用")
                continue
            target[combo] = action
            landed.add(combo)
            changed.append(f"{section} {combo} → {action['command']}")

    # 旧版本把同样的绑定同时写进了 layout:<布局名>。分区优先级高于 global，
    # 留在那儿的副本会在用户改 global 之后继续生效（改不动），因此删掉与
    # 默认值完全相同的分区副本——但只在 global 上确实落到同一个动作时才删。
    defaults = {combo: action for binds in DEFAULTS.values() for combo, action in binds.items()}
    for section in [s for s in keys if s.startswith("layout:")]:
        for combo, action in list(keys[section].items()):
            if defaults.get(combo) == action and combo in landed:
                if keys.get("global", {}).get(combo) != action:
                    continue
                del keys[section][combo]
                changed.append(f"清理 {section} {combo}：global 已覆盖同一动作")
        if not keys[section]:
            del keys[section]

    # 给 install.sh 一行机器可读的结论：它据此决定要不要宣传快捷键。
    # 让人去 grep 人类可读的行，等于让显示逻辑依赖文案格式。
    def summary_line():
        bound = ",".join(sorted(landed)) or "-"
        off = ",".join(sorted(skipped)) or "-"
        return f"SUMMARY bound={bound} skipped={off}"

    if not changed:
        print("快捷键已是最新，无需改动")
        print(summary_line())
        return 0

    # 备份名要唯一到毫秒：同一秒内跑两次会互相覆盖，把真正的原始内容弄丢。
    stamp = time.strftime("%Y%m%d%H%M%S") + f"-{int(time.time() * 1000) % 1000:03d}"
    backup = f"{KEYS}.bak-{stamp}"
    shutil.copy2(KEYS, backup)

    # keys.json 可能是 dotfiles 里的符号链接：写到它指向的真实文件，
    # 否则链接被换成普通文件、真正的配置永远停在旧内容。
    target = os.path.realpath(KEYS) if os.path.islink(KEYS) else KEYS
    # 临时文件必须和目标同目录，否则跨文件系统 rename 会 EXDEV（iCloud、
    # 挂载卷、磁盘映像）。挂载卷上 rename 也不可靠，所以 EXDEV 时回退
    # 「复制 + 删除」。
    tmp = os.path.join(os.path.dirname(target), f".{os.path.basename(target)}.tmp")
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(keys, fh, indent=2, ensure_ascii=False)
        fh.write("\n")
    if os.path.exists(target):
        shutil.copymode(target, tmp)
    try:
        os.replace(tmp, target)
    except OSError as e:
        if e.errno != errno.EXDEV:
            os.unlink(tmp)
            raise
        shutil.copy2(tmp, target)
        os.unlink(tmp)

    print(f"已更新 {KEYS}（备份 {os.path.basename(backup)}）")
    for line in changed:
        print(line)
    print(summary_line())
    return 0


if __name__ == "__main__":
    sys.exit(main())
