import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Modal } from "./Modal.tsx";

type Guard = {
  register: (id: string, dirty: boolean, discard?: () => void, retainView?: string) => () => void;
  leave: (action: () => void, id?: string, destination?: string) => boolean;
};
const Context = createContext<Guard | null>(null);

export function UnsavedChangesProvider({ children }: { children: ReactNode }) {
  const changes = useRef(new Map<string, {dirty: boolean; discard?: () => void; retainView?: string}>());
  const [pending, setPending] = useState<(() => void) | null>(null);
  const register = useCallback((id: string, dirty: boolean, discard?: () => void, retainView?: string) => {
    changes.current.set(id, {dirty, discard, retainView});
    return () => { changes.current.delete(id); };
  }, []);
  const leave = useCallback((action: () => void, id?: string, destination?: string) => {
    const ids = id ? [id] : [...changes.current.keys()].filter(key => !destination || changes.current.get(key)?.retainView !== destination);
    const dirty = ids.some(key => changes.current.get(key)?.dirty);
    if (dirty) setPending(() => () => {
      for (const key of ids) {
        const change = changes.current.get(key);
        if (change?.dirty) { change.dirty = false; change.discard?.(); }
      }
      action();
    });
    else action();
    return !dirty;
  }, []);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (![...changes.current.values()].some(change => change.dirty)) return;
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);
  return <Context.Provider value={{ register, leave }}>
    {children}
    {pending && <Modal title="保留刚才的修改吗？" className="discard-dialog" onClose={() => setPending(null)} footer={<>
      <button onClick={() => setPending(null)}>继续编辑</button>
      <button className="danger" onClick={() => { const action = pending; setPending(null); action(); }}>放弃修改</button>
    </>}><p>内容尚未确认保存。可以继续编辑，或放弃修改并离开；已开始的保存会继续。</p></Modal>}
  </Context.Provider>;
}

export function useNavigationGuard() {
  const guard = useContext(Context);
  if (!guard) throw new Error("Navigation guard requires UnsavedChangesProvider");
  return guard.leave;
}

export function useUnsavedChanges(dirty: boolean, onDiscard?: () => void, retainView?: string) {
  const guard = useContext(Context);
  if (!guard) throw new Error("Editor requires UnsavedChangesProvider");
  const id = useId();
  const discard = useRef(onDiscard);
  discard.current = onDiscard;
  useEffect(() => guard.register(id, dirty, () => discard.current?.(), retainView), [guard.register, id, dirty, retainView]);
  return Object.assign((action: () => void) => guard.leave(action, id), { markSaved: () => { guard.register(id, false); } });
}
