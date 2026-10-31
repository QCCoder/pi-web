"use client";

import type { CSSProperties, ReactNode } from "react";

/**
 * 手机壳（MobileTabShell，<768px）共用的 iOS 风格原语（2026-10 底部 tab 改版，
 * 用户反馈「Skill / 设置页面布局不好看，要符合手机端交互和审美」后抽出；2026-10-26
 * 导航统一补齐页头与菜单层）：
 *
 *   MobilePageTitle   tab 根页标题行（44px，**左对齐大标题 17px/600** + 右侧动作槽
 *                     ——2026-10-26 用户反馈「第一级 tab 页标题放左边、字体大点」；
 *                     推入页 MobileNavBar 保持居中 13/500，两级页头各有明确定位）
 *   MobileNavBar      推入页页头（44px：‹ 下一层页名 | 居中单标题 | 动作槽）——
 *                     手机推入页一律用它，不再用桌面规格的 PanelHeader（聊天页
 *                     ChatToolbar 是唯一特例，二者视觉参数一致）。标题规格统一为
 *                     会话页同款：13px/500、居中、超长省略（2026-10-26 用户反馈
 *                     「导航栏只要简洁的一个标题」撤 meta + 「大小、居中统一和会话
 *                     详情页」）。上下文由 ‹ 文案（来自哪层）与页内 hero 承载，
 *                     工作区名/路径不重复进页头。
 *   MobileMenu        ⋯ 锚定下拉菜单（scrim + 圆角卡片 + 44px 行）
 *   MobileSection     分区标题（12px muted，卡片上方）
 *   MobileCard        分组卡片（--bg-panel 圆角 + 1px 边框，行之间内缩分隔线）
 *   MobileRow         卡片内一行（可选图标块 / 主副文案 / 右侧 hint / › / 任意 trailing）
 *   MobileSwitch      46×28 开关（原生 checkbox，role=switch）
 *   MobileSearchField 圆角搜索框
 *   MobilePill        小胶囊徽章（accent / muted）
 *   MobileNote        卡片下方的说明小字
 *
 * 全部走主题 CSS 变量（AGENTS.md 变量表），跟随明暗。Skill tab 三页、设置 tab
 * 索引与全部推入页共用，保证一个视觉语言；一页放不下的内容一律推入详情页，不硬塞。
 */

export const MOBILE_CARD_STYLE: CSSProperties = {
  margin: "0 12px",
  borderRadius: 14,
  background: "var(--bg-panel)",
  border: "1px solid var(--border)",
  overflow: "hidden",
};

export function MobilePageTitle({ title, actions }: { title: string; actions?: ReactNode }) {
  return (
    <div
      style={{
        display: "flex", alignItems: "center", gap: 2,
        height: 44, padding: "0 6px 0 16px", flexShrink: 0,
        borderBottom: "1px solid var(--border)", background: "var(--bg)",
      }}
    >
      {/* 第一级 tab 根页 = 左对齐大标题（17px/600，iOS large-title 语义）；超长省略。 */}
      <span
        style={{
          flex: 1, minWidth: 0, fontSize: 17, fontWeight: 600, color: "var(--text)",
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", userSelect: "none",
        }}
      >
        {title}
      </span>
      {actions}
    </div>
  );
}

export function MobileIconButton({
  label,
  onClick,
  children,
  active = false,
  badge,
  disabled = false,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  active?: boolean;
  /** 右上角数字角标（0 / undefined 不渲染）。 */
  badge?: number;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      style={{
        position: "relative",
        display: "flex", alignItems: "center", justifyContent: "center",
        width: 40, height: 40, padding: 0, border: 0, borderRadius: 10,
        background: active ? "var(--bg-hover)" : "transparent",
        color: active ? "var(--text)" : "var(--text-muted)",
        cursor: disabled ? "default" : "pointer", flexShrink: 0,
        opacity: disabled ? 0.45 : 1,
      }}
    >
      {children}
      {badge ? (
        <span
          aria-hidden
          style={{
            position: "absolute", top: 4, right: 4, minWidth: 16, height: 16, padding: "0 4px",
            borderRadius: 8, background: "var(--accent)", color: "#fff",
            fontSize: 10, fontWeight: 600, lineHeight: "16px", textAlign: "center",
          }}
        >
          {badge > 99 ? "99+" : badge}
        </span>
      ) : null}
    </button>
  );
}

export function MobileNavBar({
  title,
  onBack,
  backLabel,
  actions,
}: {
  title: string;
  onBack?: () => void;
  /** ‹ 旁的返回目标名（= 栈里下一层页的标题；无 onBack 则不渲染）。 */
  backLabel?: string;
  /** 右侧动作槽（40×40 MobileIconButton / 小按钮）。 */
  actions?: ReactNode;
}) {
  return (
    <div
      style={{
        position: "relative", display: "flex", alignItems: "center", justifyContent: "space-between",
        height: 44, padding: "0 6px", flexShrink: 0,
        borderBottom: "1px solid var(--border)", background: "var(--bg)",
      }}
    >
      {/* 居中标题（与会话页 ChatToolbar 同一规格 13px/500）：绝对定位不被两侧
          宽度挤偏；两侧 padding 避让控件，超长省略。 */}
      <div
        style={{
          position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center",
          padding: "0 52px", pointerEvents: "none", overflow: "hidden",
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 500, color: "var(--text)", userSelect: "none", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</span>
      </div>
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          aria-label={backLabel ? `返回${backLabel}` : "返回"}
          title={backLabel ? `返回${backLabel}` : "返回"}
          style={{
            display: "flex", alignItems: "center", gap: 1,
            height: 40, maxWidth: 116, padding: "0 6px 0 0", flexShrink: 0,
            border: 0, background: "transparent", cursor: "pointer",
            color: "var(--accent)", fontSize: 15, whiteSpace: "nowrap",
          }}
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="15 18 9 12 15 6" />
          </svg>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{backLabel}</span>
        </button>
      )}
      {actions && (
        <div style={{ display: "flex", alignItems: "center", flexShrink: 0 }}>{actions}</div>
      )}
    </div>
  );
}

/** ⋯ 锚定下拉菜单：挂在使用方的 position:relative 容器里（锚在页头右下）。
 *  open=false 不渲染；scrim 点按关闭，行 = 图标 + 14px 文案、44px 触控高。 */
export function MobileMenu({
  open,
  onClose,
  ariaLabel,
  entries,
}: {
  open: boolean;
  onClose: () => void;
  ariaLabel: string;
  entries: { id: string; label: string; icon?: ReactNode; onClick: () => void }[];
}) {
  if (!open) return null;
  return (
    <>
      <div aria-hidden="true" onClick={onClose} style={{ position: "absolute", inset: 0, zIndex: 5, background: "rgba(0,0,0,0.08)" }} />
      <div
        role="menu"
        aria-label={ariaLabel}
        style={{
          position: "absolute", top: 46, right: 8, width: 216, zIndex: 6,
          background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 12,
          boxShadow: "0 10px 28px rgba(0,0,0,0.22)", overflow: "hidden",
        }}
      >
        {entries.map((entry, index) => (
          <button
            key={entry.id}
            type="button"
            role="menuitem"
            onClick={() => { onClose(); entry.onClick(); }}
            style={{
              width: "100%", display: "flex", alignItems: "center", gap: 10,
              minHeight: 44, padding: "10px 14px",
              border: 0, borderTop: index === 0 ? 0 : "1px solid var(--border)",
              background: "transparent", color: "var(--text)", fontSize: 14, cursor: "pointer", textAlign: "left",
            }}
          >
            {entry.icon && <span style={{ color: "var(--text-muted)", display: "flex" }}>{entry.icon}</span>}
            {entry.label}
          </button>
        ))}
      </div>
    </>
  );
}

export function MobileSection({ title, trailing }: { title: ReactNode; trailing?: ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 8, padding: "16px 22px 6px" }}>
      <span style={{ flex: 1, fontSize: 12, color: "var(--text-muted)", letterSpacing: 0.2 }}>{title}</span>
      {trailing}
    </div>
  );
}

export function MobileCard({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <div style={{ ...MOBILE_CARD_STYLE, ...style }}>{children}</div>;
}

export function MobileNote({ children }: { children: ReactNode }) {
  return (
    <p style={{ margin: "6px 24px 0", fontSize: 11.5, lineHeight: 1.6, color: "var(--text-dim)" }}>
      {children}
    </p>
  );
}

/** 卡片内一行。`onClick` 存在时整行可点（右侧默认带 ›）；同时给了 `trailing`
 *  （开关 / 按钮）则行主体是一个按钮、trailing 独立于其外——两处各自触控，
 *  不嵌套 button。 */
export function MobileRow({
  icon,
  iconTone,
  label,
  sublabel,
  hint,
  trailing,
  onClick,
  chevron,
  first = false,
  mono = false,
  disabled = false,
  ariaLabel,
}: {
  icon?: ReactNode;
  /** 图标块底色（设置索引用彩色瓷片；缺省中性）。 */
  iconTone?: string;
  label: ReactNode;
  sublabel?: ReactNode;
  hint?: ReactNode;
  trailing?: ReactNode;
  onClick?: () => void;
  /** 显式控制 ›（缺省：onClick 有且无 trailing → 显示）。 */
  chevron?: boolean;
  first?: boolean;
  /** 主文案等宽字体（skill 名）。 */
  mono?: boolean;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  const showChevron = chevron ?? (Boolean(onClick) && !trailing);
  const main = (
    <>
      {icon && (
        <span
          aria-hidden
          style={{
            width: 30, height: 30, borderRadius: 8, flexShrink: 0,
            display: "flex", alignItems: "center", justifyContent: "center",
            background: iconTone ?? "var(--bg-subtle)",
            color: iconTone ? "#fff" : "var(--text-muted)",
          }}
        >
          {icon}
        </span>
      )}
      <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
        <span
          style={{
            fontSize: mono ? 14 : 15, color: "var(--text)",
            fontFamily: mono ? "var(--font-mono)" : undefined,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}
        >
          {label}
        </span>
        {sublabel && (
          <span style={{ fontSize: 12, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {sublabel}
          </span>
        )}
      </span>
      {hint && (
        <span style={{ fontSize: 13, color: "var(--text-muted)", flexShrink: 0, maxWidth: "40%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {hint}
        </span>
      )}
      {showChevron && (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ color: "var(--text-dim)", flexShrink: 0, marginLeft: -2 }}>
          <polyline points="9 18 15 12 9 6" />
        </svg>
      )}
    </>
  );
  const rowStyle: CSSProperties = {
    display: "flex", alignItems: "center", gap: 12,
    minHeight: 50, padding: "10px 14px",
    background: "transparent", color: "var(--text)", textAlign: "left",
    width: "100%",
    // button 默认边框清零，只保留行间内分隔线（首行无）。
    border: 0,
    borderTopWidth: first ? 0 : 1,
    borderTopStyle: first ? "none" : "solid",
    borderTopColor: "var(--border)",
    opacity: disabled ? 0.5 : 1,
  };
  if (onClick && trailing) {
    return (
      <div style={{ ...rowStyle, padding: 0 }}>
        <button
          type="button"
          onClick={onClick}
          disabled={disabled}
          aria-label={ariaLabel}
          style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 12, padding: "10px 0 10px 14px", border: 0, background: "transparent", color: "inherit", textAlign: "left", cursor: disabled ? "default" : "pointer", minHeight: 50 }}
        >
          {main}
        </button>
        <span style={{ display: "flex", alignItems: "center", gap: 10, paddingRight: 14, flexShrink: 0 }}>{trailing}</span>
      </div>
    );
  }
  if (onClick) {
    return (
      <button type="button" onClick={onClick} disabled={disabled} aria-label={ariaLabel} style={{ ...rowStyle, cursor: disabled ? "default" : "pointer" }}>
        {main}
      </button>
    );
  }
  return (
    <div style={rowStyle}>
      {main}
      {trailing}
    </div>
  );
}

export function MobileSwitch({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={onChange}
      style={{
        position: "relative", width: 46, height: 28, borderRadius: 14, border: 0, padding: 0, flexShrink: 0,
        background: checked ? "var(--accent)" : "var(--bg-selected)",
        cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.5 : 1,
        transition: "background 0.15s",
      }}
    >
      <span
        aria-hidden
        style={{
          position: "absolute", top: 2, left: 2, width: 24, height: 24, borderRadius: "50%",
          background: "#fff", boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
          transform: checked ? "translateX(18px)" : "none", transition: "transform 0.15s",
        }}
      />
    </button>
  );
}

export function MobileSearchField({
  value,
  onChange,
  placeholder,
  onSubmit,
  autoFocus = false,
  trailing,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  onSubmit?: () => void;
  autoFocus?: boolean;
  trailing?: ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex", alignItems: "center", gap: 8, margin: "10px 12px 0",
        height: 40, borderRadius: 12, background: "var(--bg-panel)", border: "1px solid var(--border)",
        padding: "0 10px 0 12px",
      }}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ color: "var(--text-dim)", flexShrink: 0 }}>
        <circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && onSubmit) onSubmit(); }}
        placeholder={placeholder}
        aria-label={placeholder}
        autoFocus={autoFocus}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        style={{
          flex: 1, minWidth: 0, height: "100%", border: 0, outline: "none", background: "transparent",
          color: "var(--text)", fontSize: 15,
        }}
      />
      {value && (
        <button
          type="button"
          aria-label="清除"
          onClick={() => onChange("")}
          style={{ width: 24, height: 24, borderRadius: 12, border: 0, background: "var(--bg-selected)", color: "var(--text-muted)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", padding: 0, flexShrink: 0 }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
        </button>
      )}
      {trailing}
    </div>
  );
}

export function MobilePill({ children, tone = "muted" }: { children: ReactNode; tone?: "accent" | "muted" }) {
  return (
    <span
      style={{
        fontSize: 11, lineHeight: 1, padding: "4px 7px", borderRadius: 999, flexShrink: 0, whiteSpace: "nowrap",
        color: tone === "accent" ? "var(--accent)" : "var(--text-muted)",
        background: tone === "accent" ? "color-mix(in srgb, var(--accent) 13%, transparent)" : "var(--bg-subtle)",
      }}
    >
      {children}
    </span>
  );
}

export function MobileEmpty({ title, body, action }: { title: string; body?: ReactNode; action?: ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", gap: 8, padding: "48px 32px 24px", color: "var(--text-muted)" }}>
      <span style={{ fontSize: 15, color: "var(--text)" }}>{title}</span>
      {body && <span style={{ fontSize: 12.5, lineHeight: 1.6 }}>{body}</span>}
      {action && <div style={{ marginTop: 6 }}>{action}</div>}
    </div>
  );
}

export function MobilePrimaryButton({ children, onClick, disabled = false, busy = false }: { children: ReactNode; onClick: () => void; disabled?: boolean; busy?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || busy}
      style={{
        height: 34, padding: "0 14px", borderRadius: 10, border: 0, flexShrink: 0,
        background: "var(--accent)", color: "#fff", fontSize: 13, fontWeight: 600, cursor: disabled || busy ? "default" : "pointer",
        opacity: disabled ? 0.45 : busy ? 0.75 : 1,
      }}
    >
      {children}
    </button>
  );
}

export function MobileSecondaryButton({ children, onClick, disabled = false, busy = false }: { children: ReactNode; onClick: () => void; disabled?: boolean; busy?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || busy}
      style={{
        height: 32, padding: "0 12px", borderRadius: 9, border: "1px solid var(--border)", flexShrink: 0,
        background: "var(--bg)", color: "var(--text)", fontSize: 12.5, cursor: disabled || busy ? "default" : "pointer",
        opacity: disabled ? 0.45 : busy ? 0.75 : 1,
      }}
    >
      {children}
    </button>
  );
}

export function MobileErrorBanner({ children }: { children: ReactNode }) {
  return (
    <div role="alert" style={{ margin: "10px 12px 0", padding: "9px 12px", borderRadius: 10, fontSize: 12.5, lineHeight: 1.5, color: "#b91c1c", background: "color-mix(in srgb, #ef4444 12%, transparent)", border: "1px solid color-mix(in srgb, #ef4444 30%, transparent)" }}>
      {children}
    </div>
  );
}
