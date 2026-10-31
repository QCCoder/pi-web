"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { SessionInfo } from "@/lib/types";
import type { WorkItemRecord, WorkItemType } from "@/lib/work-items/types";
import type { WorkspaceRepositoryState, WorkspaceSummary } from "@/lib/workspaces/types";
import { STATUS_LABELS } from "./WorkspaceManager";
import { workspaceAvatarStyle } from "./ProjectSidebar";
import { WorkspaceSessionList } from "./WorkspaceSessionList";
import { useKitLoops } from "@/hooks/useKitLoops";

interface Props {
  workspace: WorkspaceSummary;
  /** 全量工作区列表：WorkspaceSessionList 用它做与侧栏一致的会话归属判定。 */
  workspaces: WorkspaceSummary[];
  /** shell 已有的全量会话列表（sessionActivity——与侧栏/首页同一份）。传入 =
   *  会话块零额外请求、即时渲染（2026-10 用户反馈「总览不秒出」）。 */
  sessions?: SessionInfo[];
  onNewSession: () => void;
  onOpenSettings: () => void;
  /** 工作项行点击 → 右坞工作项模块（既有行为，保留）。 */
  onOpenWorkItems: () => void;
  /** 「打开完整管理」（M2 T10，spec §6.1）：活跃工作项区头部入口 → 中央
   *  工作项管理整页（桌面 = openWorkItemsPage(wsId)；移动端 = 落工作项目
   * 的地页——那页宿的就是同一个 WorkItemsPage）。与 onOpenWorkItems 并存：
   * 一个开右坞快捷面板，一个开完整管理页。 */
  onOpenWorkItemsPage?: () => void;
  onCreateWorkItem: (type: WorkItemType) => void;
  onSelectSession: (session: SessionInfo) => void;
  /** 仓库/知识库行导航：仓库 → 右坞「文件」tab；知识库 → 右坞「知识库」tab
   *  （S2 收编；移动端 MobileShell 自行路由到 overview 栈 knowledge 页）。 */
  onSwitchSidebarView: (view: "workbench" | "knowledge") => void;
  /** Open the workspace settings' add-repository form (AppShell wires it). */
  onAddRepository: () => void;
  onSessionDeleted?: (id: string) => void;
  /** loop 变更刷新信号（创建/删除/frontmatter 保存后由 shell bump）。 */
  loopsRefreshKey?: number;
  /** 右坞 Loops tab 入口：Loops 区块渲染为摘要行（决策 #10）——点击开右坞
   *  Loops tab，状态/操作/配置只住 tab。移动端不渲染本组件（抽屉目的地页
   *  取代，更早的 WorkspaceHomeMenu 已退役）。 */
  onOpenLoopsTab: () => void;
}


// ── 布局基元（2026-10 布局优化：hero 头部 + 卡片瀑布流）──────────────────────
// 旧版一：单列满宽卡片行堆叠（稀疏、入口重复）。旧版二：三张卡 auto-fit 网格 +
// 会话列表满宽收尾——网格行对齐，矮卡旁的高卡在矮卡下方留一大块空白（用户反馈
// 「布局很奇怪」）。现版：头部（头像 + 名称/路径 + 主操作）→ 四张卡瀑布流
// （MasonryFlow：会话 / 活跃工作项 / Loops / 仓库·知识库，按此优先级逐张放进
// 当前最矮的列）；卡片内是无边框行 + hover 高亮。
const cardStyle: React.CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: 12,
  background: "var(--bg-panel)",
  padding: 6,
  minWidth: 0,
};

/**
 * 瀑布流（Pinterest 式）：按 items 顺序逐张放进当前最矮的列。为什么不用 CSS
 * `columns`——多列布局是按列填充（先填满左列再填右列），四张卡读起来变成
 * 「1、3 / 2、4」，与用户给的优先级顺序相反；真正的瀑布流同高时按行读就是
 * 「1 | 2 / 3 | 4」，高矮不等时自动补洞。
 *
 * 实现：绝对定位 + 实测高度。卡片始终是同一父节点下的同一 DOM（只改 top/left），
 * 换列不会卸载重挂——「显示全部」等卡内状态不丢。高度用 useLayoutEffect 在首帧
 * 提交后同步量一次（setState 触发同步重渲染，用户看不到未测量的中间态），之后
 * ResizeObserver 跟随内容变化（数据到达、展开）；列数由容器宽度决定
 * （floor((w+gap)/(minColumnWidth+gap))，窄屏自动单列）。DOM 顺序 = 优先级顺序，
 * 读屏器按 1→4 读。
 */
/** 瀑布流列高「近似等高」阈值（px）：小于一行卡片内容行（≈44–52px）。 */
const NEAR_EQUAL_TOLERANCE = 32;

function MasonryFlow({ items, gap = 12, minColumnWidth = 320, style }: {
  items: { key: string; node: ReactNode }[];
  gap?: number;
  minColumnWidth?: number;
  style?: React.CSSProperties;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef(new Map<string, HTMLDivElement>());
  const [width, setWidth] = useState(0);
  const [heights, setHeights] = useState<Record<string, number>>({});
  const itemKeys = items.map((item) => item.key).join("|");
  // 位置过渡只在首帧绘制之后开启：useLayoutEffect 里的测量会强制浏览器解析第一次
  // 渲染（单列、未测高）的样式，若此时就带 transition，首帧会从那个中间态滑到终态。
  const [animate, setAnimate] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setAnimate(true));
    return () => cancelAnimationFrame(id);
  }, []);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const observer = new ResizeObserver((entries) => {
      setHeights((prev) => {
        let next = prev;
        for (const entry of entries) {
          const key = (entry.target as HTMLElement).dataset.masonryKey;
          if (!key) continue;
          const height = (entry.target as HTMLElement).offsetHeight;
          if (prev[key] !== height) {
            if (next === prev) next = { ...prev };
            next[key] = height;
          }
        }
        return next;
      });
    });
    const initial: Record<string, number> = {};
    for (const [key, el] of itemRefs.current) {
      initial[key] = el.offsetHeight;
      observer.observe(el);
    }
    setHeights((prev) => ({ ...prev, ...initial }));
    return () => observer.disconnect();
  }, [itemKeys]);

  const columns = Math.max(1, Math.min(items.length || 1, Math.floor((width + gap) / (minColumnWidth + gap))));
  const columnHeights = new Array<number>(columns).fill(0);
  const placed = items.map((item) => {
    let column = 0;
    for (let c = 1; c < columns; c += 1) {
      if (columnHeights[c] < columnHeights[column]) column = c;
    }
    // 近似等高（差 ≤ 一行以内）视为平手，偏向靠前的列：否则十几像素的高差就会把
    // 第 3、4 张卡左右对调，按行读不再是「1 | 2 / 3 | 4」，看起来像随机。高矮悬殊
    // 时仍然填最矮列——那才是瀑布流补洞的意义。
    for (let c = 0; c < column; c += 1) {
      if (columnHeights[c] - columnHeights[column] <= NEAR_EQUAL_TOLERANCE) {
        column = c;
        break;
      }
    }
    const top = columnHeights[column];
    columnHeights[column] += (heights[item.key] ?? 0) + gap;
    return { item, column, top };
  });
  const containerHeight = Math.max(0, Math.max(...columnHeights) - gap);
  const columnWidth = `calc((100% - ${gap * (columns - 1)}px) / ${columns})`;

  return (
    <div ref={containerRef} style={{ ...style, position: "relative", height: containerHeight || undefined }}>
      {placed.map(({ item, column, top }) => (
        <div
          key={item.key}
          data-masonry-key={item.key}
          ref={(el) => {
            if (el) itemRefs.current.set(item.key, el);
            else itemRefs.current.delete(item.key);
          }}
          style={{
            position: "absolute",
            top,
            left: `calc(${column} * (${columnWidth} + ${gap}px))`,
            width: columnWidth,
            transition: animate ? "top 0.15s ease, left 0.15s ease" : undefined,
          }}
        >
          {item.node}
        </div>
      ))}
    </div>
  );
}

const cardHeaderStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "8px 10px 6px",
  fontSize: 12.5,
  fontWeight: 600,
  color: "var(--text-muted)",
  userSelect: "none",
};

const countChipStyle: React.CSSProperties = {
  fontSize: 10.5,
  fontWeight: 500,
  color: "var(--text-dim)",
  background: "var(--bg-hover)",
  borderRadius: 999,
  padding: "1px 7px",
};

const cardHeaderLinkStyle: React.CSSProperties = {
  border: 0,
  background: "transparent",
  color: "var(--accent)",
  cursor: "pointer",
  padding: 0,
  fontSize: 11.5,
  fontWeight: 500,
};

const cardRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  width: "100%",
  padding: "8px 10px",
  border: 0,
  borderRadius: 8,
  background: "transparent",
  color: "var(--text)",
  cursor: "pointer",
  textAlign: "left",
  transition: "background 0.12s",
};

const cardEmptyStyle: React.CSSProperties = {
  padding: "18px 10px 14px",
  textAlign: "center",
  color: "var(--text-dim)",
  fontSize: 12,
};

const primaryActionStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "8px 14px",
  border: "1px solid color-mix(in srgb, var(--accent) 45%, var(--border))",
  borderRadius: 9,
  background: "color-mix(in srgb, var(--accent) 12%, transparent)",
  color: "var(--accent)",
  cursor: "pointer",
  fontWeight: 600,
  fontSize: 13,
  whiteSpace: "nowrap",
};

export function WorkspaceOverview({
  workspace,
  workspaces,
  sessions,
  onNewSession,
  onOpenSettings,
  onOpenWorkItems,
  onOpenWorkItemsPage,
  onCreateWorkItem,
  onSelectSession,
  onSwitchSidebarView,
  onAddRepository,
  onSessionDeleted,
  loopsRefreshKey,
  onOpenLoopsTab,
}: Props) {
  const [workItems, setWorkItems] = useState<WorkItemRecord[]>([]);
  const [repositories, setRepositories] = useState<WorkspaceRepositoryState[]>([]);
  const { loops } = useKitLoops(workspace.id, loopsRefreshKey);

  const hasWorkItems = workspace.capabilities.includes("work-items");
  const hasRepositories = workspace.capabilities.includes("repositories");
  const hasKnowledge = workspace.capabilities.includes("knowledge");

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      hasWorkItems
        ? fetch(`/api/workspaces/${encodeURIComponent(workspace.id)}/work-items`, {
          signal: controller.signal,
        })
        : null,
      hasRepositories || hasKnowledge
        ? fetch(`/api/workspaces/${encodeURIComponent(workspace.id)}/repositories`, {
          signal: controller.signal,
        })
        : null,
    ]).then(async ([itemsResponse, repositoriesResponse]) => {
      if (itemsResponse?.ok) {
        const data = await itemsResponse.json() as { items?: WorkItemRecord[] };
        setWorkItems(data.items ?? []);
      }
      if (repositoriesResponse?.ok) {
        const data = await repositoriesResponse.json() as {
          repositories?: WorkspaceRepositoryState[];
        };
        setRepositories(data.repositories ?? []);
      }
    }).catch((error) => {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        console.error("Failed to load workspace overview:", error);
      }
    });
    return () => controller.abort();
  }, [workspace.id, hasWorkItems, hasRepositories, hasKnowledge]);

  // 活跃工作项：非终态（status 非 done/cancelled、未归档），按 updatedAt 倒序取前 5。
  const activeWorkItems = useMemo(
    () => workItems
      .filter((item) =>
        !item.archivedAt
        && item.status !== "done"
        && item.status !== "cancelled")
      .sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""))
      .slice(0, 5),
    [workItems],
  );

  const activeCodeRepositories = useMemo(
    () => repositories.filter((repository) =>
      repository.kind === "code" && repository.status === "active"),
    [repositories],
  );
  const knowledgeBundleCount = useMemo(
    () => repositories.filter((repository) =>
      repository.kind === "knowledge" && repository.status === "active").length,
    [repositories],
  );

  // 瀑布流卡片，数组顺序 = 放置优先级（用户要求：会话最前 → 工作项 → Loops →
  // 仓库/知识库）；能力门控后至少 会话 + Loops 两张。会话卡共享 WorkspaceSessionList
  // （移动端工作区 tab 的会话子页同体，那里不传 embedded）。
  const cards: { key: string; node: ReactNode }[] = [
    {
      key: "sessions",
      node: (
        <section style={cardStyle} aria-label="会话">
          <WorkspaceSessionList
            embedded
            workspace={workspace}
            workspaces={workspaces}
            sessions={sessions}
            onSelectSession={onSelectSession}
            onSessionDeleted={onSessionDeleted}
          />
        </section>
      ),
    },
    ...(hasWorkItems ? [{
      key: "work-items",
      node: (
        <section style={cardStyle} aria-label="活跃工作项">
          <h2 style={{ ...cardHeaderStyle, margin: 0 }}>
            活跃工作项
            <span style={countChipStyle}>{activeWorkItems.length}</span>
            <span style={{ flex: 1 }} />
            {onOpenWorkItemsPage && (
              <button
                onClick={onOpenWorkItemsPage}
                title="打开完整的工作项管理弹窗（列表/看板/卡片——卡片可拖拽改状态）"
                style={cardHeaderLinkStyle}
              >
                完整管理
              </button>
            )}
            <button
              onClick={() => onCreateWorkItem("requirement")}
              style={{ ...cardHeaderLinkStyle, border: "1px solid var(--border)", borderRadius: 6, padding: "1px 7px" }}
            >
              ＋ 新建
            </button>
          </h2>
          {activeWorkItems.length === 0 ? (
            <div style={cardEmptyStyle}>暂无活跃工作项</div>
          ) : (
            activeWorkItems.map((item) => (
              <button
                key={item.id}
                onClick={onOpenWorkItems}
                title={`${item.key} ${item.title}`}
                style={cardRowStyle}
                onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
              >
                <span style={{ flexShrink: 0, color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: 11 }}>
                  {item.key}
                </span>
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12.5 }}>
                  {item.title}
                </span>
                <span style={{ flexShrink: 0, fontSize: 11, padding: "2px 8px", borderRadius: 8, border: "1px solid var(--border)", color: "var(--text-muted)" }}>
                  {STATUS_LABELS[item.status]}
                </span>
              </button>
            ))
          )}
        </section>
      ),
    }] : []),
    {
      key: "loops",
      node: (
        <section style={cardStyle} aria-label="Loops">
          <h2 style={{ ...cardHeaderStyle, margin: 0 }}>
            Loops
            {loops.length > 0 && <span style={countChipStyle}>{loops.length}</span>}
          </h2>
          <button
            onClick={onOpenLoopsTab}
            style={cardRowStyle}
            onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
          >
            <span style={{ display: "flex", alignItems: "center", color: "var(--text-muted)", flexShrink: 0 }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M17 2l4 4-4 4" /><path d="M3 11v-1a4 4 0 0 1 4-4h14" />
                <path d="M7 22l-4-4 4-4" /><path d="M21 13v1a4 4 0 0 1-4 4H3" />
              </svg>
            </span>
            <span style={{ flex: 1, display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
              <span style={{ fontWeight: 500, fontSize: 12.5 }}>
                {loops.length === 0 ? "暂无 loop" : `${loops.length} 个 loop`}
              </span>
              <span style={{ fontSize: 11.5, color: "var(--text-muted)" }}>
                {(() => {
                  const running = loops.filter((loop) => loop.running).length;
                  const paused = loops.filter((loop) => loop.paused).length;
                  if (loops.length === 0) return "文件即声明：.pi/loops/<name>/LOOP.md";
                  const parts: string[] = [];
                  if (running > 0) parts.push(`${running} 个运行中`);
                  if (paused > 0) parts.push(`${paused} 个已暂停`);
                  if (running === 0 && paused === 0) parts.push("全部就绪");
                  return parts.join(" · ");
                })()}
              </span>
            </span>
            <span style={{ color: "var(--text-dim)", fontSize: 14 }}>›</span>
          </button>
        </section>
      ),
    },
    ...((hasRepositories || hasKnowledge) ? [{
      key: "repositories",
      node: (
        <section style={cardStyle} aria-label="仓库与知识库">
          <h2 style={{ ...cardHeaderStyle, margin: 0 }}>
            仓库 / 知识库
            <span style={{ flex: 1 }} />
            {hasRepositories && (
              <button onClick={onAddRepository} style={cardHeaderLinkStyle}>＋ 添加仓库</button>
            )}
          </h2>
          {hasRepositories && activeCodeRepositories.length === 0 && !hasKnowledge && (
            <div style={cardEmptyStyle}>暂无代码仓库</div>
          )}
          {hasRepositories && activeCodeRepositories.map((repository) => (
            <button
              key={repository.id}
              onClick={() => onSwitchSidebarView("workbench")}
              title="在工作台文件区中浏览"
              style={cardRowStyle}
              onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
            >
              <span style={{ flexShrink: 0, minWidth: 0, maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12.5 }}>
                {repository.name}
              </span>
              <span style={{ flex: 1 }} />
              <span style={{ flexShrink: 0, display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
                {repository.branch || "—"}
                {repository.dirty && (
                  <span
                    title="有未提交改动"
                    aria-label="有未提交改动"
                    style={{ width: 8, height: 8, borderRadius: "50%", background: "#d6a84b", display: "inline-block" }}
                  />
                )}
              </span>
            </button>
          ))}
          {hasKnowledge && (
            <button
              onClick={() => onSwitchSidebarView("knowledge")}
              title="在右坞知识库模块中查看"
              style={cardRowStyle}
              onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
            >
              <span style={{ flexShrink: 0, fontSize: 12.5 }}>知识库</span>
              <span style={{ flex: 1 }} />
              <span style={{ flexShrink: 0, fontSize: 11, color: "var(--text-dim)" }}>
                {knowledgeBundleCount > 0 ? `${knowledgeBundleCount} 个知识库` : "尚未配置"}
              </span>
            </button>
          )}
        </section>
      ),
    }] : []),
  ];

  return (
    <main
      aria-label={`${workspace.name} overview`}
      style={{ height: "100%", overflow: "auto", padding: "clamp(20px, 4vw, 44px)" }}
    >
      <div style={{ width: "min(880px, 100%)", margin: "0 auto" }}>
        {/* Header（hero）：项目首字头像（与侧栏同一份哈希配色）+ 名称/路径 +
            主操作。新建会话收进 hero（旧版独立快捷行撤除——新建工作项只留
            工作项卡片头部一处，不再重复）。 */}
        <header style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
          <span
            aria-hidden
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 42,
              height: 42,
              borderRadius: 11,
              fontSize: 17,
              fontWeight: 700,
              flexShrink: 0,
              ...workspaceAvatarStyle(workspace.name),
            }}
          >
            {[...workspace.name][0]?.toUpperCase() ?? "?"}
          </span>
          <div style={{ flex: 1, minWidth: 200 }}>
            <h1 style={{ margin: 0, fontSize: 19, fontWeight: 650, color: "var(--text)", lineHeight: 1.3 }}>{workspace.name}</h1>
            <code style={{ color: "var(--text-dim)", fontSize: 11 }}>{workspace.path}</code>
          </div>
          <button onClick={onNewSession} style={primaryActionStyle}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            新建会话
          </button>
          <button className="workspace-action" onClick={onOpenSettings}>工作区设置</button>
        </header>

        {/* 模块卡片瀑布流（2026-10 用户反馈：auto-fit 网格的行是对齐的，矮卡旁边
            的高卡会在矮卡下面留一大块空白；并要求会话排最前）：MasonryFlow 按
            cards 顺序逐张放进当前最矮的列，宽度不够自动单列（移动端总览目的地页
            同体）。 */}
        <MasonryFlow style={{ marginTop: 18 }} items={cards} />
      </div>
    </main>
  );
}
