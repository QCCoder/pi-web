export interface InitialNavigation {
  sessionId: string | null;
}

export function getInitialNavigation(searchParams: Pick<URLSearchParams, "get">): InitialNavigation {
  return {
    sessionId: searchParams.get("session"),
  };
}
