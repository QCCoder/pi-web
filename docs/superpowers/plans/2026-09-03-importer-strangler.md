# Importer Strangler（禅道同步下放工作区）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** pi-web 删除全部 Chandao importer 代码（~740 行 lib + 路由 + UI + daemon job + capability 退役），同步语义完整迁移为 workspace-c 的 `scripts/chandao-sync.py`（纯 stdlib，走 pi-web 通用 API），实测后收尾。

**Architecture:** strangler 顺序（spec 硬约束）：映射决策表已摘录（附录 A）→ 新脚本先行并 dry-run 验证 → cxin 文档/manifest 更新 → 才删 pi-web 代码 → 真跑实测收尾。脚本只依赖五个通用端点（list/create/events/attachments），域逻辑零复刻。

**Tech Stack:** Python 3 stdlib（urllib/json/re/argparse）、Next.js 既有 API、node:test。

**Spec:** `docs/superpowers/specs/2026-09-03-importer-strangler-design.md`

## Global Constraints

- pi-web 每 task 结束：`node_modules/.bin/tsc --noEmit` 0 错 + `npm test` 全绿；never `next build`；不新增依赖。
- workspace-c 是独立 git 仓（`~/.pi/workspaces/workspace-c`）——在那里工作的 task 直接在该目录编辑并用**它自己的 git** 提交（只 add 本任务文件；**不碰** `loops/dev-loop/STATE.md` 等运行时未提交内容）。
- 脚本零第三方依赖（纯 stdlib）；凭据文件 0600 且 gitignored；脚本输出/日志不得打印密码或 token。
- 单条 item 失败不中断同步（failed[] 记录）；结构性失败（登录失败/API 不可达/凭据缺失）退出码 2。
- **spec 勘误（以现行为为准，runner.ts 注释为证）**：已存在未归档项 **不盖** `imported` 里程碑（防 events 洪水，REQ-0012 教训）；仅在摘要计数 `synced`。
- pi-web API 无任何改动（`CreateWorkItemInput.external` 已存在）——发现"需要改 API 才能跑通"即为计划错误，停下报告。

## 附录 A：映射决策表（从旧实现逐字摘录——脚本的唯一权威）

| 项 | 决策 |
|---|---|
| 就绪状态 | bug: `active`；task: `doing`（REST 忽略 assignedTo 查询参数 → 客户端按 status + `assignedTo.account === assignee` 双过滤）|
| 拉取 | bugs: `GET {base}/api.php/v1/products/{productId}/bugs?assignedTo={assignee}` → `data.bugs[{id,title,status,assignedTo}]`；tasks: `GET {base}/api.php/v1/executions/{executionId}/tasks?assignedTo=` → `data.tasks[{id,name,status,assignedTo}]`；`assignedTo` 可能是 `{account,…}` 对象/字符串/null |
| 详情 | bug: `GET /api.php/v1/bugs/{id}` → `{id,title,steps}`（正文=steps）；task: `GET /api.php/v1/tasks/{id}` → `{id,name,desc}`（正文=desc）|
| 深链 | bug: `{base}/index.php?m=bug&f=view&bugID={id}`；task: `{base}/index.php?m=task&f=view&taskID={id}` |
| 认证 | `POST {base}/api.php/v1/tokens` body `{account,password}` → `{token}`；请求头 `Token: <t>`；401 → 重签一次重试一次 |
| 文件 | `GET /api.php/v1/files/{fileId}`（Token 头）→ 二进制流；扩展名魔数：PNG `89 50 4E 47 0D 0A 1A 0A` / JPG `FF D8 FF` / GIF `GIF8` / WEBP `RIFF…WEBP`(8..12)；回退 Content-Type `image/<x>`（jpeg→jpg）；再回退 `bin` |
| 类型映射 | chandao bug → work-item `bug`；task → `requirement`；title 回退 `Bug #id` / `Task #id`；**不传 priority** |
| 去重 | `external{source:"chandao", sourceId}` 为键，对 `items ∪ archivedItems` 建索引；归档 → skip；未归档已存在 → synced 计数、无事件；新 → 创建 |
| 创建 body | `{type, title, originalDescription, external{source,sourceId,url?,lastSyncedAt: <now ISO>}, tags:["chandao"], actor:"external"}` |
| 空描述回退 | 正文 trim 为空 → `（chandao 来源描述为空，详见标题与外部链接）` |
| 图片提取 | `/fileID=(\d+)/g` 顺序去重；重写 `src=(["'])([^"']*fileID=(\d+)[^"']*)\1`（忽略大小写）→ `src=<q>attachments/chandao-<id>.<ext><q>`；非 chandao src 不动 |
| 事件 | 新建后 `POST …/events` `{type:"imported", actor:"external", data:{action:"created", source:"chandao", sourceId, lastSyncedAt}}`（append 不 bump revision，expectedRevision 省略）|
| 附件上传 | 建项（正文已含本地 src）→ `POST …/attachments`（multipart 字段名 `files`，文件名 `chandao-<id>.<ext>`）→ 从响应 `events` 里最后一条 `work_item.attachment_added` 的 `data.files` 读**权威落盘名**；若与期望不符 → `PUT …/content` `{expectedRevision: <响应 detail.item.revision>, content: <按落盘名重写的正文>, actor:"external"}` |
| 摘要 | `{created:[KEY…], synced:N, skipped:N, failed:[{sourceId,error}…]}`；逐条 try/except |

pi-web 端点（均已在）：`GET/POST /api/workspaces/{ws}/work-items`（GET 返回 `{items,archivedItems,invalid}`，external 为 camelCase）、`POST …/work-items/{key}/events`、`POST …/work-items/{key}/attachments`（返回 `WorkItemDetail{path,item,content,events}`）、`PUT …/work-items/{key}/content`。`ws` 可用 slug。

---

### Task 1: `source-labels.ts` 迁出 importers 目录

**Files:**
- Create: `lib/workspaces/../work-items/source-labels.ts`（即 `lib/work-items/source-labels.ts`，内容原样）
- Delete: `lib/work-items/importers/source-labels.ts`
- Modify: 消费方 import 路径（先 `grep -rn "importers/source-labels" --include="*.ts*" app components lib` 枚举，逐个改为 `@/lib/work-items/source-labels` 或相对路径）

**Interfaces:** Produces: `SOURCE_LABELS: Record<string,string>`（导出不变，仅位置）——Task 4 删除 importers 目录的前置。

- [ ] **Step 1**: grep 枚举消费方 → git mv（或复制+删）→ 更新 import → `node_modules/.bin/tsc --noEmit` + `npm test` → commit `refactor: source-labels 迁出 importers（保留通用溯源 UI）`

### Task 2: `scripts/chandao-sync.py`（workspace-c，dry-run 验证）

**Files（workspace-c 仓）:**
- Create: `scripts/chandao-sync.py`
- Modify: `.gitignore`（+= `.chandao.json`）
- Create: `.chandao.json`（0600，**不进 git**——从 `~/.pi/agent/importers/01KYRBBY917PW4X0VHMY5GC8TE.json` 的 chandao 节取 `base/account/password/assignee/productId/executionId`，丢弃 token）

**Interfaces:** Produces: `python3 scripts/chandao-sync.py [--workspace c] [--api http://127.0.0.1:30141] [--dry-run]`；退出码 0=完成（可有 failed[]）/ 2=结构性失败；stdout 末行摘要 JSON（附录 A 摘要形状）。

- [ ] **Step 1**: 写脚本（完整代码如下，逐字为基；按附录 A 语义）：

```python
#!/usr/bin/env python3
"""禅道 → 工作项 同步（chandao.md 的机器面）。确定性 I/O；轮开场第 2 步调用。

用法: python3 scripts/chandao-sync.py [--workspace c] [--api http://127.0.0.1:30141] [--dry-run]
退出码: 0 完成(逐条失败进 failed[]) / 2 结构性失败(凭据缺失、登录失败、API 不可达)——轮应泊车整轮。
stdout 末行: {"created":[KEY...],"synced":N,"skipped":N,"failed":[{"sourceId":..,"error":..}]}
"""
import argparse, json, os, re, sys, urllib.error, urllib.request
from datetime import datetime, timezone
from pathlib import Path

READY = {"bug": ("active",), "task": ("doing",)}
FILE_ID_RE = re.compile(r"fileID=(\d+)")
IMG_SRC_RE = re.compile(r'src=(["\'])([^"\']*fileID=(\d+)[^"\']*)\1', re.I)
MAGIC = ((b"\x89PNG\r\n\x1a\n", "png"), (b"\xff\xd8\xff", "jpg"), (b"GIF8", "gif"))
EMPTY_BODY = "（chandao 来源描述为空，详见标题与外部链接）"


def detect_ext(data: bytes, ctype: str) -> str:
    for sig, ext in MAGIC:
        if data.startswith(sig):
            return ext
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    m = re.search(r"image/([\w.+-]+)", (ctype or "").lower())
    if m:
        return "jpg" if m.group(1) == "jpeg" else m.group(1)
    return "bin"


def account_of(value) -> str:
    if isinstance(value, dict):
        return value.get("account") or ""
    return value if isinstance(value, str) else ""


class Chandao:
    def __init__(self, cfg: dict):
        self.base = cfg["base"].rstrip("/")
        self.account, self.password = cfg["account"], cfg["password"]
        self.assignee, self.product_id, self.execution_id = (
            cfg["assignee"].strip(), cfg["productId"], cfg["executionId"])
        self.token = None

    def _sign_in(self) -> str:
        req = urllib.request.Request(
            f"{self.base}/api.php/v1/tokens", method="POST",
            data=json.dumps({"account": self.account, "password": self.password}).encode(),
            headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read() or b"{}")
        if not data.get("token"):
            raise RuntimeError("chandao 登录未返回 token")
        self.token = data["token"]
        return self.token

    def request(self, path: str):
        token = self.token or self._sign_in()
        for _ in range(2):
            req = urllib.request.Request(
                f"{self.base}{path}", headers={"Token": token})
            try:
                with urllib.request.urlopen(req, timeout=30) as resp:
                    return json.loads(resp.read() or b"{}")
            except urllib.error.HTTPError as err:
                if err.code == 401:
                    token = self._sign_in()
                    continue
                raise
        raise RuntimeError(f"chandao 请求失败: {path}")

    def download(self, file_id: str) -> tuple[bytes, str]:
        req = urllib.request.Request(
            f"{self.base}/api.php/v1/files/{file_id}",
            headers={"Token": self.token or self._sign_in()})
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = resp.read()
            return data, detect_ext(data, resp.headers.get("Content-Type", ""))

    def list_assigned(self) -> list[dict]:
        out = []
        bugs = self.request(
            f"/api.php/v1/products/{self.product_id}/bugs?assignedTo={self.assignee}"
        ).get("bugs", [])
        for b in bugs:
            if b.get("status") in READY["bug"] and account_of(b.get("assignedTo")) == self.assignee:
                out.append({"sourceId": str(b["id"]), "kind": "bug",
                            "title": b.get("title") or f"Bug #{b['id']}",
                            "url": f"{self.base}/index.php?m=bug&f=view&bugID={b['id']}"})
        tasks = self.request(
            f"/api.php/v1/executions/{self.execution_id}/tasks?assignedTo={self.assignee}"
        ).get("tasks", [])
        for t in tasks:
            if t.get("status") in READY["task"] and account_of(t.get("assignedTo")) == self.assignee:
                out.append({"sourceId": str(t["id"]), "kind": "task",
                            "title": t.get("name") or f"Task #{t['id']}",
                            "url": f"{self.base}/index.php?m=task&f=view&taskID={t['id']}"})
        return out

    def detail(self, source_id: str, kind: str) -> dict:
        path = f"/api.php/v1/bugs/{source_id}" if kind == "bug" else f"/api.php/v1/tasks/{source_id}"
        data = self.request(path)
        if kind == "bug":
            body, title = data.get("steps") or "", data.get("title") or f"Bug #{source_id}"
        else:
            body, title = data.get("desc") or "", data.get("name") or f"Task #{source_id}"
        return {"sourceId": source_id, "kind": kind, "title": title, "body": body, "url": None}


class PiWeb:
    def __init__(self, api: str, ws: str):
        self.base, self.ws = api.rstrip("/"), ws

    def _url(self, suffix: str) -> str:
        return f"{self.base}/api/workspaces/{self.ws}{suffix}"

    def request(self, method: str, suffix: str, body=None, raw=None, headers=None):
        data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        req = urllib.request.Request(self._url(suffix), method=method, data=data,
                                     headers=headers or ({"Content-Type": "application/json"} if data and raw is None else {}))
        with urllib.request.urlopen(req, timeout=120) as resp:
            payload = resp.read()
            return json.loads(payload) if payload else {}

    def list_work_items(self) -> dict:
        return self.request("GET", "/work-items")

    def create(self, payload: dict) -> dict:
        return self.request("POST", "/work-items", payload)

    def milestone(self, key: str, payload: dict) -> dict:
        return self.request("POST", f"/work-items/{key}/events", payload)

    def upload(self, key: str, files: list[tuple[str, bytes]]) -> dict:
        boundary = "----chandaoSync" + str(os.getpid())
        parts = []
        for name, blob in files:
            parts.append(
                f'--{boundary}\r\nContent-Disposition: form-data; name="files"; filename="{name}"\r\n'
                f"Content-Type: application/octet-stream\r\n\r\n".encode() + blob + b"\r\n")
        parts.append(f"--{boundary}--\r\n".encode())
        return self.request("POST", f"/work-items/{key}/attachments", raw=b"".join(parts),
                            headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})

    def put_content(self, key: str, revision: int, content: str) -> dict:
        return self.request("PUT", f"/work-items/{key}/content",
                            {"expectedRevision": revision, "content": content, "actor": "external"})


def extract_file_ids(html: str) -> list[str]:
    seen, out = set(), []
    for m in FILE_ID_RE.finditer(html):
        if m.group(1) not in seen:
            seen.add(m.group(1))
            out.append(m.group(1))
    return out


def rewrite_img(html: str, ext_of) -> str:
    return IMG_SRC_RE.sub(
        lambda m: f'src={m.group(1)}attachments/chandao-{m.group(3)}.{ext_of(m.group(3)) or "bin"}{m.group(1)}',
        html)


def structural_fail(msg: str):
    print(msg, file=sys.stderr)
    sys.exit(2)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--workspace", default="c")
    ap.add_argument("--api", default=os.environ.get("PI_WEB_API", "http://127.0.0.1:30141"))
    ap.add_argument("--config", default=str(Path(__file__).resolve().parent.parent / ".chandao.json"))
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    cfg_path = Path(args.config)
    if not cfg_path.exists():
        structural_fail(f"凭据缺失: {cfg_path}（0600，gitignored；形状见 chandao.md）")
    cfg = json.loads(cfg_path.read_text())
    chandao, pi = Chandao(cfg), PiWeb(args.api, args.workspace)
    now = datetime.now(timezone.utc).isoformat()

    try:
        sources = chandao.list_assigned()
    except Exception as err:  # 结构性：登录/网络失败
        structural_fail(f"禅道拉取失败: {err}")

    try:
        existing = pi.list_work_items()
    except Exception as err:
        structural_fail(f"pi-web API 不可达（{args.api}）: {err}")
    index = {}
    for item in existing.get("items", []) + existing.get("archivedItems", []):
        ext = item.get("external")
        if ext:
            index[f"{ext.get('source')}:{ext.get('sourceId')}"] = item

    summary = {"created": [], "synced": 0, "skipped": 0, "failed": []}
    for src in sources:
        key = f"chandao:{src['sourceId']}"
        hit = index.get(key)
        if hit and hit.get("archivedAt"):
            summary["skipped"] += 1
            continue
        if hit:  # 未归档已存在：计数即可，不盖里程碑（REQ-0012 噪音教训）
            summary["synced"] += 1
            continue
        if args.dry_run:
            summary["created"].append(f"dry:{src['kind']}#{src['sourceId']} {src['title']}")
            continue
        try:
            detail = chandao.detail(src["sourceId"], src["kind"])
            file_ids = extract_file_ids(detail["body"])
            blobs = {fid: chandao.download(fid) for fid in file_ids}
            body = rewrite_img(detail["body"], lambda fid: blobs.get(fid, (b"", ""))[1])
            description = body.strip() or EMPTY_BODY
            detail_url = detail.get("url") or src["url"]
            created = pi.create({
                "type": "bug" if src["kind"] == "bug" else "requirement",
                "title": detail["title"],
                "originalDescription": description,
                "external": {"source": "chandao", "sourceId": src["sourceId"],
                             "url": detail_url, "lastSyncedAt": now},
                "tags": ["chandao"], "actor": "external"})
            item = created["item"]
            summary["created"].append(item["key"])
            pi.milestone(item["key"], {"type": "imported", "actor": "external",
                                       "data": {"action": "created", "source": "chandao",
                                                "sourceId": src["sourceId"], "lastSyncedAt": now}})
            if blobs:
                detail2 = pi.upload(item["key"], [
                    (f"chandao-{fid}.{ext}", blob) for fid, (blob, ext) in blobs.items()])
                landed = []
                for ev in detail2.get("events", []):
                    if ev.get("type") == "work_item.attachment_added":
                        landed = ev.get("data", {}).get("files", [])
                expected = [f"chandao-{fid}.{ext}" for fid, (_, ext) in blobs.items()]
                if sorted(landed) != sorted(expected):  # 落盘名被去重后缀改写 → 修正正文引用
                    fixed = detail["body"]
                    for want, got in zip(expected, landed):
                        fixed = fixed.replace(f"attachments/{want}", f"attachments/{got}")
                    pi.put_content(item["key"], detail2["item"]["revision"], fixed)
        except Exception as err:
            summary["failed"].append({"sourceId": src["sourceId"], "error": str(err)})
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == "__main__":
    main()
```

- [ ] **Step 2**: `.gitignore` += `.chandao.json`；创建 0600 凭据（内容来源见 Files 节）。
- [ ] **Step 3**: dry-run 验证：pi-web dev server 在跑 → `python3 scripts/chandao-sync.py --dry-run` → 核对输出与手工判断一致（`GET …/work-items` 的 chandao external 项 vs 禅道待开发清单）；**不写任何东西**。
- [ ] **Step 4**: workspace-c 仓提交（仅 scripts/chandao-sync.py + .gitignore；**.chandao.json 不提交**）：`feat: 禅道同步脚本（chandao-sync.py，替代 pi-web importer）`

### Task 3: cxin 文档与 manifest 更新（workspace-c）

**Files（workspace-c 仓）:** `loops/dev-loop/chandao.md`（重写「怎么运行」）、`loops/dev-loop/LOOP.md`（第 2 步）、`.pi/workspace.yaml`（capabilities 去 `requirement-sources`）。

- [ ] **Step 1**: chandao.md「怎么运行」节替换为：

```markdown
## 怎么运行

- **脚本**：`python3 scripts/chandao-sync.py`（确定性同步：拉取→去重→建项→图片本地化→摘要）。
  凭据：workspace 根 `.chandao.json`（0600，gitignored，不进上下文）。幂等，可重复跑。
- **触发**：① dev-loop 轮开场（LOOP.md 第 2 步，bash 调用）② 手动 ③ 可选 crontab。
- **结果语义**：stdout 末行摘要 `{"created":[…],"synced":N,"skipped":N,"failed":[…]}`。
  退出码 0=完成（`failed` 里的项盖 `loop.parked` 报人，其余照常选品）；**退出码 2=结构性失败**
  （凭据缺失/登录失败/pi-web API 不可达）→ 整轮泊车报人，不在陈旧候选池上选品。
- **pi-web 依赖**：脚本经 pi-web 通用 API 建项（server 需存活；轮触发场景天然满足）。
```

「怎么变成工作项」「对选品的意义」两节仅把"daemon 30min/凭据路径/手动同步入口"等旧机制措辞替换为脚本表述，语义不变。

- [ ] **Step 2**: LOOP.md 第 2 步替换为：`2. 读 loops/dev-loop/chandao.md 并运行 python3 scripts/chandao-sync.py（bash；退出码 2 → 本轮泊车报人；摘要 failed 项盖 loop.parked 报人，其余照常）`
- [ ] **Step 3**: manifest capabilities 移除 `requirement-sources`（保留其余）。
- [ ] **Step 4**: 提交（三文件）：`docs: chandao 同步改为脚本触发（LOOP.md 步骤 2 + manifest 退役 requirement-sources）`

### Task 4: pi-web 删除 + capability 退役（pi-web 仓）

**Files:**
- Delete: `lib/work-items/importers/`（整目录；source-labels 已在 Task 1 迁出）、`app/api/workspaces/[id]/importers/`（整目录）、`components/ImporterConfig.tsx`
- Modify: `components/WorkspaceManager.tsx`（去 ImporterConfig 挂载 + requirement-sources 开关行）、`lib/daemon/host.ts`（删 ImporterScheduler import/注册 + createImporterRoutes 路由段）、`lib/daemon/client.ts`（删 importer sync 方法）、`lib/workspaces/service.ts`（ALL_WORKSPACE_CAPABILITIES 去 `requirement-sources`；L178-183 注释与 force-include 映射删除；`LEGACY_READ_CAPABILITIES` += `"requirement-sources"`）、`lib/workspaces/types.ts`（WorkspaceCapability 联合去该项）、`lib/work-items/types.ts`（external 注释改"外部源脚本经 HTTP API 盖章；LLM 工具不透传"）、`AGENTS.md`
- Test: `lib/workspaces/capability-retire.test.mjs`（新）

- [ ] **Step 1**: 写失败测试（manifest capabilities 含 `requirement-sources` → `parseWorkspaceManifest` 解析成功且被剥离；`parseCapabilities(["requirement-sources"])` 抛 `WorkspaceValidationError`）。夹具：最小合法 manifest（schema_version/id/slug/name/capabilities:[sessions,explorer,requirement-sources]/repositories/agent/git?/work_items?/created_at/updated_at——以 parseWorkspaceManifest 实际必填字段为准，先读该函数再定夹具）。
- [ ] **Step 2**: 跑测试确认失败 → 实施删除/修改 → `tsc --noEmit` + `npm test` 全绿（importer 测试随目录消失；若其它测试引用 importers 则一并清理）。
- [ ] **Step 3**: AGENTS.md：Importer 章节替换为「外部源适配 = 工作区脚本」一段（cxin `scripts/chandao-sync.py` 为参考实例，摘要/泊车语义）；capability 注册表清单去 requirement-sources 并注明已退役；目录布局删 `agent/importers/` 行；File Map 删 importers/route/ImporterConfig 行、加 source-labels 新位置。
- [ ] **Step 4**: commit `feat!: 移除 pi-web importer（禅道同步下放工作区脚本，capability requirement-sources 退役）`

### Task 5: 真跑实测 + 收尾

- [ ] **Step 1**: 真同步：`python3 ~/.pi/workspaces/workspace-c/scripts/chandao-sync.py`（**不带** --dry-run；若禅道当前无可建新项，先在禅道造一条指派测试 bug 或接受 synced/skipped-only 结果并说明）。
- [ ] **Step 2**: 抽查新建项（若有）：README 原文逐字 + inline `attachments/chandao-*.png` src、attachments/ 落盘、events 含 `imported` 与 `attachment_added`、item.yaml `external` 块；workspace-c git log 有对应 commit。
- [ ] **Step 3**: 轮验证：`POST /api/workspaces/c/loops/dev-loop/run`（手动轮）确认开场第 2 步真跑同步（观察会话消息或 STATE.md）；若在 cron 窗口内也可等自然心跳。**执行时二选一并记录**。
- [ ] **Step 4**: 删 `~/.pi/agent/importers/01KYRBBY917PW4X0VHMY5GC8TE.json`（实测通过后）。
- [ ] **Step 5**: 终验三连：pi-web `tsc` + `npm test` + `npm run lint`（增量 0 error）；workspace-c `git status` 无意外脏文件。
- [ ] **Step 6**: commit（如有 AGENTS.md 补充）+ ledger 收尾。

## Self-Review（已执行）

**Spec coverage**：§4 删除清单→Task 4（7 项全落）；§5 脚本契约→Task 2（附录 A 全量）；§6 迁移→Task 2/3/5；§7 失败语义→脚本退出码+chandao.md；§8 测试→Task 4 Step 1 + Task 2 Step 3 + Task 5 实测；§3 决策表→逐项落附录 A/任务。**勘误落位**：spec §5.3「已存在→盖 imported 里程碑」按 runner 现行为修正为不盖（Global Constraints 声明）。
**Placeholder**：无 TBD；manifest 夹具"以 parseWorkspaceManifest 实际必填字段为准"是先读后写的显式指令（防拍脑袋造错夹具）。
**类型一致**：脚本摘要形状 ↔ chandao.md 文档 ↔ 附录 A；`WorkItemDetail{item,content,events}` 用法与 service 实测一致；`UpdateWorkItemContentInput{expectedRevision,content,actor}` 一致。
