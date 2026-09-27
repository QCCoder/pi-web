"use client";

import { useSyncExternalStore } from "react";

const emptySubscribe = () => () => {};
const getClient = () => true;
const getServer = () => false;

/**
 * 水合安全开关：SSR 与客户端水合首帧返回 false（与 getServerSnapshot 一致，
 * 不触发 hydration mismatch），水合完成后返回 true。用于「依赖 Date.now()/
 * localStorage/locale 等环境影响」的渲染值——先渲染稳定占位，水合后再显示
 * 真实值（React 官方推荐模式，useTheme 同款 useSyncExternalStore 手法）。
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(emptySubscribe, getClient, getServer);
}
