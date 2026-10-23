"use client";

import { useRef, useState } from "react";
import type { ChangeEvent } from "react";
import type { WorkItemPriority, WorkItemType } from "@/lib/work-items/types";

/** 新建工作项表单（从 WorkspaceManager 抽出共用，M2 T9）：类型/标题/原始
 *  描述/优先级/仓库范围/附件 + enableDelivery 勾选（缺省不勾，spec §7.1——
 *  标准交付流程由人显式启用）。字段状态由本组件持有，宿主只收
 *  onSubmit(values)；两处宿主（中央页 / WorkspaceManager 快捷面板）沿用同一
 *  创建 POST 与附件上传语义。inline-style 自带卡片与响应式（flex wrap），
 *  不依赖宿主样式表。 */

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export interface WorkItemCreateFormValues {
  type: WorkItemType;
  title: string;
  originalDescription: string;
  priority: WorkItemPriority;
  repositories: string[];
  /** 标准交付流程 opt-in（缺省 false，spec §7.1）。 */
  enableDelivery: boolean;
  files: File[];
}

const cardStyle: React.CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: 10,
  background: "var(--bg-panel)",
  padding: 14,
};

const fieldStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 5,
  color: "var(--text-muted)",
  fontSize: 11,
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  border: "1px solid var(--border)",
  borderRadius: 7,
  background: "var(--bg)",
  color: "var(--text)",
  padding: "7px 10px",
  font: "inherit",
  fontSize: 13,
  outline: "none",
};

const buttonStyle: React.CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: 7,
  background: "var(--bg)",
  color: "var(--text-muted)",
  cursor: "pointer",
  minHeight: 30,
  padding: "0 12px",
  font: "inherit",
  fontSize: 12,
  whiteSpace: "nowrap",
};

/** 待上传附件选择器（多次点击叠加；同名移除后可重选）。创建表单与详情页
 *  附件上传共用。 */
export function WorkItemAttachmentPicker({
  files,
  onChange,
  disabled,
}: {
  files: File[];
  onChange: (files: File[]) => void;
  disabled?: boolean;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const handlePicked = (event: ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(event.target.files ?? []);
    if (picked.length > 0) onChange([...files, ...picked]);
    event.target.value = "";
  };
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
      <button
        type="button"
        className="workspace-action"
        style={buttonStyle}
        disabled={disabled}
        onClick={() => fileInputRef.current?.click()}
      >
        + 添加附件
      </button>
      {files.map((file, index) => (
        <span
          key={`${file.name}-${file.size}-${index}`}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            border: "1px solid var(--border)",
            borderRadius: 999,
            padding: "2px 8px",
            fontSize: 12,
            color: "var(--text-muted)",
            maxWidth: "100%",
          }}
        >
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {file.name} · {formatFileSize(file.size)}
          </span>
          <button
            type="button"
            aria-label={`移除附件 ${file.name}`}
            disabled={disabled}
            style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: "var(--text-dim)", lineHeight: 1 }}
            onClick={() => onChange(files.filter((_, i) => i !== index))}
          >
            ×
          </button>
        </span>
      ))}
      <input ref={fileInputRef} type="file" multiple hidden onChange={handlePicked} />
    </div>
  );
}

export function WorkItemCreateForm({
  repositories,
  initialType = "bug",
  defaultRepositoryIds = [],
  saving = false,
  submitLabel = "创建工作项",
  onCancel,
  onSubmit,
}: {
  /** 可勾选的仓库（宿主过滤后传入，一般 = active 仓库）。 */
  repositories: Array<{ id: string; name: string; kind: "code" | "knowledge"; status: string }>;
  initialType?: WorkItemType;
  /** 打开表单时预勾选的仓库（WorkspaceManager 沿用「全部 active code 仓」默认）。 */
  defaultRepositoryIds?: string[];
  saving?: boolean;
  submitLabel?: string;
  onCancel: () => void;
  onSubmit: (values: WorkItemCreateFormValues) => void;
}) {
  const [type, setType] = useState<WorkItemType>(initialType);
  const [title, setTitle] = useState("");
  const [originalDescription, setOriginalDescription] = useState("");
  const [priority, setPriority] = useState<WorkItemPriority>("P2");
  const [selectedRepositories, setSelectedRepositories] = useState<string[]>(defaultRepositoryIds);
  const [enableDelivery, setEnableDelivery] = useState(false);
  const [files, setFiles] = useState<File[]>([]);

  const canSubmit = !saving && title.trim() !== "" && originalDescription.trim() !== "";

  return (
    <div style={{ ...cardStyle, display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
        <label style={{ ...fieldStyle, flex: "0 0 120px" }}>
          <span>类型</span>
          <select
            value={type}
            style={inputStyle}
            onChange={(event) => setType(event.target.value as WorkItemType)}
          >
            <option value="requirement">需求</option>
            <option value="bug">Bug</option>
          </select>
        </label>
        <label style={{ ...fieldStyle, flex: "0 0 120px" }}>
          <span>优先级</span>
          <select
            value={priority}
            style={inputStyle}
            onChange={(event) => setPriority(event.target.value as WorkItemPriority)}
          >
            {(["P0", "P1", "P2", "P3"] as const).map((value) => (
              <option key={value} value={value}>{value}</option>
            ))}
          </select>
        </label>
        <label style={{ ...fieldStyle, flex: "1 1 240px", minWidth: 200 }}>
          <span>标题</span>
          <input
            value={title}
            style={inputStyle}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="简短描述需要完成或修复的事情"
            autoFocus
          />
        </label>
      </div>
      <label style={fieldStyle}>
        <span>原始描述</span>
        <textarea
          value={originalDescription}
          style={{ ...inputStyle, minHeight: 110, resize: "vertical" }}
          onChange={(event) => setOriginalDescription(event.target.value)}
          placeholder="保留你最初的描述，Agent 后续分析不会覆盖它。"
        />
      </label>
      {repositories.length > 0 && (
        <div style={fieldStyle}>
          <span>关联仓库</span>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {repositories.map((repository) => (
              <label
                key={repository.id}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                  border: "1px solid var(--border)",
                  borderRadius: 999,
                  padding: "5px 9px",
                  background: "var(--bg)",
                  color: "var(--text-muted)",
                  fontSize: 11,
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  checked={selectedRepositories.includes(repository.id)}
                  onChange={(event) => {
                    setSelectedRepositories((current) => event.target.checked
                      ? [...new Set([...current, repository.id])]
                      : current.filter((id) => id !== repository.id));
                  }}
                />
                {repository.name} · {repository.kind === "code" ? "代码" : "知识库"}
              </label>
            ))}
          </div>
        </div>
      )}
      <div style={fieldStyle}>
        <span>附件</span>
        <WorkItemAttachmentPicker files={files} onChange={setFiles} disabled={saving} />
      </div>
      <label
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: 7,
          cursor: "pointer",
          color: "var(--text)",
          fontSize: 12,
        }}
        title="启用后走标准交付流（设计确认 → 实现 → 验证 → 发布，阶段只经动作推进）；不勾选则沿用旧 phase/loop 兼容操作"
      >
        <input
          type="checkbox"
          data-field="enableDelivery"
          checked={enableDelivery}
          onChange={(event) => setEnableDelivery(event.target.checked)}
          style={{ marginTop: 2 }}
        />
        <span>
          启用标准交付流程
          <span style={{ display: "block", color: "var(--text-dim)", fontSize: 11 }}>
            设计确认、候选验证与发布登记由人按门禁推进（缺省不启用）
          </span>
        </span>
      </label>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button type="button" style={buttonStyle} onClick={onCancel}>取消</button>
        <button
          type="button"
          style={buttonStyle}
          disabled={!canSubmit}
          onClick={() =>
            onSubmit({
              type,
              title: title.trim(),
              originalDescription: originalDescription.trim(),
              priority,
              repositories: selectedRepositories,
              enableDelivery,
              files,
            })
          }
        >
          {saving ? "创建中…" : submitLabel}
        </button>
      </div>
    </div>
  );
}
