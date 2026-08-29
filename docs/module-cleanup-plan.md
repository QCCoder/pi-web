# Module Cleanup Plan — lib/ 平铺文件归拢清单

> 背景：pi-web 的 `lib/` 里，redesign 生的域（workspaces / work-items / loop / subagent / daemon）已经是目录化的，
> 但增量长出来的域全是根级平铺文件。2026-08 的 daemon 重构（pi-loop → pi-daemon、importers →
> lib/work-items/importers/）只处理了语义归属问题；本清单是剩下的**纯机械大扫除**：零行为变化、纯路径移动 +
> import 改写，单独一次提交做完，不与任何语义重构混合。

规则：每个域一个目录；目录内相对引用；`@/lib/<domain>/...` 别名引用全部改写；测试文件随宿主文件搬移。
做完后更新 AGENTS.md 文件地图，并跑 `tsc --noEmit` + `npm test` + dev 冒烟。

## 1. git 域 → `lib/git/`

| 文件 | 去向 |
|---|---|
| `lib/git-changes.ts` (+test) | `lib/git/changes.ts` |
| `lib/git-status.ts` | `lib/git/status.ts` |
| `lib/git-discover.ts` (+test) | `lib/git/discover.ts` |
| `lib/git-types.ts` | `lib/git/types.ts` |
| `lib/worktree.ts` | `lib/git/worktree.ts`（worktree 本质是 git 操作，`/api/worktrees` 引用方改路径） |

## 2. 会话读侧 → `lib/sessions/`

| 文件 | 去向 |
|---|---|
| `lib/session-reader.ts` (+test) | `lib/sessions/reader.ts`（`cacheSessionPath` 被 daemon/rpc-manager 引用，改 `../sessions/reader`） |
| `lib/session-index.ts` (+test) | `lib/sessions/index.ts` |
| `lib/session-archive.ts` | `lib/sessions/archive.ts` |
| `lib/session-changed-files.ts` (+test) | `lib/sessions/changed-files.ts` |
| `lib/session-title.ts` (+test) | `lib/sessions/title.ts`（被 daemon/http-sessions 引用） |
| `lib/session-path.ts` (+test) | `lib/sessions/path.ts` |
| `lib/session-file-references*.ts` | `lib/sessions/file-references.ts` |

注意：`lib/daemon/` 是**进程归属**（daemon-only），`lib/sessions/` 是**读侧工具**（web 进程也用）——两者不要合并。

## 3. 文件域 → `lib/files/`

| 文件 | 去向 |
|---|---|
| `lib/file-access.ts` (+test) | `lib/files/access.ts`（allow-list，被 `/api/files`、`/api/git`、worktrees 用） |
| `lib/file-paths.ts` / `file-types.ts` / `file-fuzzy.ts` / `file-index.ts` / `file-links.ts` / `file-dirent.ts` (+tests) | `lib/files/paths.ts` / `types.ts` / `fuzzy.ts` / `index.ts` / `links.ts` / `dirent.ts` |
| `lib/file-upload.ts` (+test) | `lib/files/upload.ts` |
| `lib/directory-browser.ts` (+test) | `lib/files/directory-browser.ts` |
| `lib/allowed-roots.ts` | `lib/files/allowed-roots.ts`（若与 access.ts 语义重叠，顺手合并） |

## 4. skills/plugins 域 → `lib/skills/`

| 文件 | 去向 |
|---|---|
| `lib/skills-service.ts` | `lib/skills/service.ts` |
| `lib/skill-lock.ts` / `skill-message.ts` / `skill-updates.ts` (+tests) | `lib/skills/lock.ts` / `message.ts` / `updates.ts` |
| `lib/npx.ts` | `lib/skills/npx.ts`（只被 skills install 用） |

## 5. models 域 → `lib/models/`

| 文件 | 去向 |
|---|---|
| `lib/model-catalog.ts` (+test) | `lib/models/catalog.ts` |
| `lib/model-discovery.ts` / `model-discovery-auth.ts` (+test) | `lib/models/discovery.ts` / `discovery-auth.ts` |
| `lib/models-cache.ts` (+test) | `lib/models/cache.ts`（被 daemon/rpc-manager 引用，改路径） |
| `lib/stores/models-store*` | 可选：并入 `lib/models/`，或留在 stores（客户端缓存归属 stores 也说得通） |

## 6. 剩余散件（归拢时顺手判断）

- `lib/patch.ts`、`lib/path-security.ts`、`lib/request-security.ts`、`lib/http-dispatcher.ts`、`lib/project-trust.ts` →
  `lib/http/`（web 服务端安全/路由公共件）；`project-trust` 被 daemon 引用，注意路径。
- `lib/markdown.ts`、`lib/ansi.ts`、`lib/message-display.ts`、`lib/compaction-summary.ts`、`lib/chat-lazy-load.ts` →
  `lib/render/`（纯展示工具）。
- `lib/types.ts`、`lib/api-types.ts`、`lib/pi-types.ts`、`lib/normalize.ts`、`lib/tool-presets.ts` 留在根级
  （跨域共享类型，无家可归是正常的）。
- `lib/abort-race.ts`、`lib/bash-output.ts`、`lib/image-attachments.ts`、`lib/terminal-input.ts`、
  `lib/custom-ui-terminal.ts`、`lib/bounded-form-data.ts`、`lib/clipboard.ts`、`lib/draft-store.ts` ——
  逐个看引用面再定，不强行归堆。

## 验收

1. `node_modules/.bin/tsc --noEmit` 通过；
2. `npm test` 全绿（测试文件随宿主搬移后 import 全部相对化）；
3. `npm run dev` 冒烟：会话列表/新建会话/SSE/文件树/改动面板/skills 面板/models 面板各点一遍；
4. AGENTS.md 文件地图同步重写。
