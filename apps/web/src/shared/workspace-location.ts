import { useEffect, useRef, useState } from "react";
import type { View } from "./WorkspaceShell.tsx";
import { useNavigationGuard } from "./UnsavedChanges.tsx";

export type WorkspaceLocation = { view: View; object: string | null; tab: string; scope: "tables" | "all" | "maintained"; assetsTab: "memory" | "skill" | "shared" };
function readLocation(): WorkspaceLocation {
  const [page, search = ""] = window.location.hash.slice(1).split("?");
  const params = new URLSearchParams(search);
  const view = page === "knowledge" || page === "assets" ? page : "workbench";
  const scope = params.get("scope");
  const asset = params.get("tab");
  return { view, object: params.get("object"), tab: params.get("tab") || "概览", scope: scope === "all" || scope === "maintained" ? scope : "tables", assetsTab: asset === "skill" || asset === "shared" ? asset : "memory" };
}
function address(value: WorkspaceLocation) {
  const params = new URLSearchParams();
  if (value.view === "knowledge") { if (value.object) params.set("object", value.object); params.set("tab", value.tab); params.set("scope", value.scope); }
  if (value.view === "assets") params.set("tab", value.assetsTab);
  return "#" + value.view + (params.size ? "?" + params : "");
}
export function useWorkspaceLocation() {
  const [location, setLocation] = useState(readLocation);
  const current = useRef(location);
  const position = useRef(Number(history.state?.dataAgentPosition) || 0);
  const leave = useNavigationGuard();
  const apply = (next: WorkspaceLocation, index: number) => { current.current = next; position.current = index; setLocation(next); };
  useEffect(() => {
    history.replaceState({ ...history.state, dataAgentPosition: position.current }, "", address(current.current));
    let restoring = false, approved = false;
    const back = () => {
      if (restoring) { restoring = false; return; }
      const next = readLocation(), index = Number(history.state?.dataAgentPosition) || 0;
      if (approved) { approved = false; apply(next, index); return; }
      let immediate = true;
      const distance = index - position.current;
      const allowed = leave(() => {
        if (immediate || !distance) { history.replaceState({ ...history.state, dataAgentPosition: index }, "", address(next)); apply(next, index); }
        else { approved = true; history.go(distance); }
      });
      immediate = false;
      if (!allowed) {
        if (distance) { restoring = true; history.go(-distance); }
        else history.replaceState({ ...history.state, dataAgentPosition: position.current }, "", address(current.current));
      }
    };
    window.addEventListener("popstate", back);
    return () => window.removeEventListener("popstate", back);
  }, [leave]);
  const navigate = (patch: Partial<WorkspaceLocation>, replace = false) => leave(() => {
    const next = { ...current.current, ...patch };
    if (address(next) !== address(current.current)) {
      const index = position.current + (replace ? 0 : 1);
      history[replace ? "replaceState" : "pushState"]({ dataAgentPosition: index }, "", address(next));
      apply(next, index);
    } else apply(next, position.current);
  });
  return { location, navigate };
}
