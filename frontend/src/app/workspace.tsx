import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "../lib/api";
import { useLocalState, usePolling } from "../lib/hooks";
import type { Business } from "../lib/types";

export interface WorkspaceInfo { id: number; created_at: string; businesses: number; storage: string }

interface WorkspaceState {
  workspace: WorkspaceInfo | null;
  businesses: Business[];
  loading: boolean;
  error: string | null;
  current: Business | null;
  setCurrentId: (id: number | null) => void;
  refresh: () => Promise<void>;
}

const Ctx = createContext<WorkspaceState | null>(null);

/** Opens (or resumes) this browser's anonymous workspace, then loads its businesses.
    There is no sign-in: the server identifies the workspace by a cookie. */
export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentId, setCurrentId] = useLocalState<number | null>("startup-business", null);

  const refresh = useCallback(async () => {
    try {
      setBusinesses(await api.get<Business[]>("/api/businesses"));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        setWorkspace(await api.post<WorkspaceInfo>("/api/workspace"));
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      }
    })();
  }, [refresh]);

  // Keep run counts current only while the server reports active simulations.
  usePolling(refresh, businesses.some((b) => b.active_runs > 0), 1500);
  const current = useMemo(() => businesses.find((b) => b.id === currentId) ?? businesses[0] ?? null, [businesses, currentId]);
  return <Ctx.Provider value={{ workspace, businesses, loading, error, current, setCurrentId, refresh }}>{children}</Ctx.Provider>;
}

export function useWorkspace() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useWorkspace outside WorkspaceProvider");
  return v;
}
