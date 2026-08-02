"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/hooks/useI18n";
import type { ParsedSkillMessage } from "@/lib/skill-message";
import { MarkdownBody } from "./MarkdownBody";

interface Props {
  skill: ParsedSkillMessage;
  cwd?: string;
  onOpenFile?: (filePath: string) => void;
}

interface PopoverPosition {
  top: number;
  right: number;
  width: number;
  maxHeight: number;
}

function SkillReference({ skill }: { skill: ParsedSkillMessage }) {
  const { t } = useI18n();
  const rootRef = useRef<HTMLSpanElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [position, setPosition] = useState<PopoverPosition | null>(null);
  const command = `/skill:${skill.name}`;
  const visible = !dismissed && (hovered || focused || pinned);

  const cancelScheduledClose = useCallback(() => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  }, []);

  const scheduleHoverClose = useCallback(() => {
    cancelScheduledClose();
    closeTimerRef.current = setTimeout(() => setHovered(false), 100);
  }, [cancelScheduledClose]);

  const close = useCallback(() => {
    cancelScheduledClose();
    setPinned(false);
    setDismissed(true);
  }, [cancelScheduledClose]);

  useEffect(() => () => cancelScheduledClose(), [cancelScheduledClose]);

  useEffect(() => {
    if (!visible) {
      setPosition(null);
      return;
    }

    const updatePosition = () => {
      const rect = rootRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(540, window.innerWidth - 32);
      const maxAllowedRight = Math.max(8, window.innerWidth - width - 8);
      const right = Math.min(Math.max(8, window.innerWidth - rect.right), maxAllowedRight);
      const below = window.innerHeight - rect.bottom - 15;
      const above = rect.top - 15;
      const heightLimit = window.innerHeight * 0.65;
      if (below >= Math.min(240, above)) {
        setPosition({ top: rect.bottom + 7, right, width, maxHeight: Math.min(heightLimit, Math.max(120, below)) });
      } else {
        const maxHeight = Math.min(heightLimit, Math.max(120, above));
        setPosition({ top: Math.max(8, rect.top - maxHeight - 7), right, width, maxHeight });
      }
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [visible]);

  useEffect(() => {
    if (!visible) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (pinned && !rootRef.current?.contains(target) && !popoverRef.current?.contains(target)) {
        setPinned(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [close, pinned, visible]);

  const popover = visible && position && typeof document !== "undefined"
    ? createPortal(
        <div
          ref={popoverRef}
          role="dialog"
          aria-label={t("chat.skillDetails", { name: skill.name })}
          onMouseEnter={() => { cancelScheduledClose(); setHovered(true); }}
          onMouseLeave={scheduleHoverClose}
          style={{
            position: "fixed",
            zIndex: 150,
            top: position.top,
            right: position.right,
            display: "block",
            width: position.width,
            maxHeight: position.maxHeight,
            overflow: "auto",
            padding: 12,
            border: "1px solid var(--border)",
            borderRadius: 9,
            background: "var(--bg)",
            color: "var(--text)",
            boxShadow: "0 12px 32px rgba(0,0,0,0.24)",
            textAlign: "left",
            whiteSpace: "normal",
          }}
        >
          <div style={{ marginBottom: 10, paddingBottom: 9, borderBottom: "1px solid var(--border)" }}>
            <strong style={{ display: "block", fontSize: 13, lineHeight: 1.4 }}>{command}</strong>
            <span style={{ display: "block", marginTop: 3, color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: 10.5, lineHeight: 1.4, overflowWrap: "anywhere" }}>
              {skill.location}
            </span>
          </div>
          <div style={{ marginBottom: 6, color: "var(--text-dim)", fontSize: 10, fontWeight: 650, textTransform: "uppercase", letterSpacing: "0.04em" }}>
            {t("chat.skillSnapshot")}
          </div>
          <MarkdownBody className="markdown-custom-message">{skill.instructions}</MarkdownBody>
        </div>,
        document.body,
      )
    : null;

  return (
    <span
      ref={rootRef}
      style={{ position: "relative", display: "inline-block" }}
      onMouseEnter={() => { cancelScheduledClose(); setHovered(true); setDismissed(false); }}
      onMouseLeave={scheduleHoverClose}
      onFocus={() => { setFocused(true); setDismissed(false); }}
      onBlur={() => setFocused(false)}
    >
      <button
        type="button"
        className="markdown-inline-code"
        aria-label={t("chat.skillDetails", { name: skill.name })}
        aria-expanded={visible}
        aria-haspopup="dialog"
        onClick={() => { setPinned((value) => !value); setDismissed(false); }}
        style={{ border: 0, cursor: "pointer", lineHeight: "inherit" }}
      >
        {command}
      </button>
      {popover}
    </span>
  );
}

export function SkillMessageContent({ skill, cwd, onOpenFile }: Props) {
  const command = `/skill:${skill.name}`;
  const markdown = `\`${command}\`${skill.userMessage ? ` ${skill.userMessage}` : ""}`;

  return (
    <MarkdownBody
      className="markdown-user-message"
      cwd={cwd}
      onOpenFile={onOpenFile}
      renderInlineCode={(value) => value === command ? <SkillReference skill={skill} /> : undefined}
    >
      {markdown}
    </MarkdownBody>
  );
}
