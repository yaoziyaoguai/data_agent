import { useEffect, useRef, useState } from 'react';
import type { ConversationSkillSelection, ConversationSkillSelections, SkillSelectionRemoval } from '../../../../../packages/contracts/generated/boundary.ts';
import { api } from '../../shared/api.ts';

const labels: Record<ConversationSkillSelection['availability'], string> = {
  available: '已选用', version_changed: '方法有更新，请重新选用', disabled: '已停用',
  dependency_unavailable: '依赖资料已失效或无权读取', unavailable: '已删除或不可访问',
};
export function SkillSelections({cid, onManage, refreshRevision}: {cid: string; onManage: () => void; refreshRevision?: string}) {
  const [items, setItems] = useState<ConversationSkillSelection[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [changeBlocked, setChangeBlocked] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [removalError, setRemovalError] = useState('');
  const [removalRetry, setRemovalRetry] = useState<ConversationSkillSelection | null>(null);
  const [notice, setNotice] = useState('');
  const pages = useRef(1);
  const activeConversation = useRef(cid);
  activeConversation.current = cid;
  const pendingRemovals = useRef(new Map<string, SkillSelectionRemoval>());
  const reload = useRef<() => void>(() => {});
  const observedRevision = useRef(refreshRevision ?? '');
  useEffect(() => {
    let current = true, busy = false, refreshRequested = false, generation = 0;
    pages.current = 1;
    pendingRemovals.current.clear();
    setItems([]); setNext(null); setLoading(true); setError('');
    setRemoving(null); setRemovalError(''); setRemovalRetry(null); setNotice('');
    const refresh = async () => {
      if (document.visibilityState === 'hidden') return;
      if (busy) { refreshRequested = true; return; }
      busy = true;
      const requestGeneration = generation;
      try {
        let after: string | null = null;
        let blocked = false;
        const entries: ConversationSkillSelection[] = [];
        for (let page = 0; page < pages.current; page++) {
          const value: ConversationSkillSelections = await api('ConversationSkillSelections', '/conversations/' + cid + '/skill-selections' + (after ? '?after_id=' + encodeURIComponent(after) : ''));
          if (!current || generation !== requestGeneration) return;
          entries.push(...value.selections); after = value.next_after_id;
          blocked ||= value.change_blocked;
          if (!after || document.hidden) break;
        }
        if (current) { setItems(entries); setNext(after); setChangeBlocked(blocked); setError(''); }
      } catch (e) { if (current && generation === requestGeneration) setError(e instanceof Error ? e.message : '读取失败'); }
      finally {
        busy = false;
        if (current) {
          setLoading(false);
          if (refreshRequested) { refreshRequested = false; void refresh(); }
        }
      }
    };
    const update = () => { generation++; void refresh(); };
    reload.current = update;
    update();
    const timer = window.setInterval(update, 30_000);
    window.addEventListener('focus', update);
    document.addEventListener('visibilitychange', update);
    return () => { current = false; clearInterval(timer); window.removeEventListener('focus', update); document.removeEventListener('visibilitychange', update); };
  }, [cid]);
  useEffect(() => {
    const revision = refreshRevision ?? '';
    if (observedRevision.current !== revision) {
      observedRevision.current = revision;
      reload.current();
    }
  }, [refreshRevision]);
  const remove = async (item: ConversationSkillSelection) => {
    if (removing || changeBlocked) return;
    const origin = cid;
    setRemoving(item.selection_id); setRemovalError(''); setRemovalRetry(null); setNotice('');
    let command = pendingRemovals.current.get(item.selection_id);
    if (!command) {
      command = { operation_id: crypto.randomUUID(), asset_id: item.asset_id, selection_id: item.selection_id };
      pendingRemovals.current.set(item.selection_id, command);
    }
    try {
      await api('SkillRemovalReceipt', '/conversations/' + cid + '/skill-selections', 'DELETE', command);
      if (activeConversation.current !== origin) return;
      pendingRemovals.current.delete(item.selection_id);
      setItems(old => old.filter(value => value.selection_id !== item.selection_id));
      setNotice('已从本会话移除。方法仍保存在积累中，其他会话不受影响。');
      reload.current();
    } catch (e) {
      if (activeConversation.current !== origin) return;
      const code = e instanceof Error ? e.message : '';
      setRemovalError(code === 'message_pending'
        ? '当前输入尚未结束，请等待生成完成，或先处理待恢复的输入，再移除方法。'
        : code === 'version_conflict'
          ? '选择已变化，请核对刷新后的方法再操作。'
          : '暂时无法确认是否已移除。可重试移除，系统会核对同一次操作。');
      if (code === 'version_conflict') pendingRemovals.current.delete(item.selection_id);
      if (code !== 'version_conflict' && code !== 'message_pending') setRemovalRetry(item);
      reload.current();
    } finally { if (activeConversation.current === origin) setRemoving(null); }
  };
  if (!loading && !error && !items.length && !notice && !removalError) return null;
  return <section className="skill-selections" aria-label="本会话已选 Skill">
    <div className="selection-heading"><strong>已选分析方法</strong><button onClick={onManage}>管理与选用</button></div>
    {loading && <p role="status">正在读取已选方法…</p>}
    {error && <p className="error" role="alert">已选方法读取失败，暂不能确认当前状态。{error} <button onClick={() => reload.current()}>重试</button></p>}
    {notice && <p role="status">{notice}</p>}
    {removalError && <p className="error" role="alert">{removalError}{removalRetry && <button disabled={changeBlocked || removing !== null} onClick={() => void remove(removalRetry)}>重试移除</button>}</p>}
    {changeBlocked && !!items.length && <p className="quiet">当前输入尚未结束，完成后可移除方法。</p>}
    {!loading && !error && !items.length && <p className="quiet">尚未选用，可直接提问。</p>}
    {!error && items.map(item => <div key={item.asset_id} className={'skill-selection ' + item.availability}>
      <span><strong>{item.name ?? '不可用的 Skill'}</strong></span>
      <small>{item.visibility === 'space' ? '空间公共' : item.visibility === 'personal' ? '个人' : '来源不可访问'} · {labels[item.availability]}</small>
      <button className="text-link" disabled={changeBlocked || removing !== null} onClick={() => void remove(item)} aria-label={'从本会话移除 ' + (item.name ?? '不可用的 Skill')}>{removing === item.selection_id ? '正在移除…' : '从本会话移除'}</button>
    </div>)}
    {next && !error && <button onClick={() => { pages.current++; reload.current(); }}>加载更多已选方法</button>}
  </section>;
}
