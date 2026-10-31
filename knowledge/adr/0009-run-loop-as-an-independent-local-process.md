# Run Loop as an independent local process

> **已被 M1 单进程宿主取代（2026-10 标注）**：loop 心跳现由 Next.js 宿主进程内 `LoopKitSpawner` 驱动，pi-web 不再只是管理适配器；独立进程形态仅保留为 standalone 根的 `pi-loop beat` CLI 第二心跳源（`knowledge/designs/pi-loop-host-design.md`）。

The shared Loop Service runs in an independent local Loop Host, while Pi Web is only a management adapter and Pi AgentSession is the Round execution adapter. Binding scheduling and dispatch to the Pi Web server would make the generic Loop capability unavailable to CLI/TUI users and would couple unattended execution to a UI lifecycle; the existing experimental `lib/loop` job model and its data/API compatibility are intentionally not preserved during replacement.
