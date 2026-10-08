import { useEffect, useRef, useState } from 'react';
import type { ConversationSkillSelection, ConversationSkillSelections } from '../../../../../packages/contracts/generated/boundary.ts';
import { api } from '../../shared/api.ts';

const labels: Record<ConversationSkillSelection['availability'], string> = {
  available: '可供本会话采用', version_changed: '版本已变化，请重新选用', disabled: '已停用',
  dependency_unavailable: '依赖资料已失效或无权读取', unavailable: '已删除或不可访问',
};
export function SkillSelections({cid, onManage}: {cid: string; onManage: () => void}) {
  const [items, setItems] = useState<ConversationSkillSelection[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const pages = useRef(1);
  const reload = useRef<() => void>(() => {});
  useEffect(() => {
    let current = true, busy = false;
    const refresh = async () => {
      if (busy) return;
      busy = true;
      try {
        let after: string | null = null;
        const entries: ConversationSkillSelection[] = [];
        for (let page = 0; page < pages.current; page++) {
          const value: ConversationSkillSelections = await api('ConversationSkillSelections', '/conversations/' + cid + '/skill-selections' + (after ? '?after_id=' + encodeURIComponent(after) : ''));
          if (!current) return;
          entries.push(...value.selections); after = value.next_after_id;
          if (!after) break;
        }
        if (current) { setItems(entries); setNext(after); setError(''); }
      } catch (e) { if (current) setError(e instanceof Error ? e.message : '读取失败'); }
      finally { busy = false; if (current) setLoading(false); }
    };
    reload.current = () => { void refresh(); };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 700);
    window.addEventListener('focus', reload.current);
    return () => { current = false; clearInterval(timer); window.removeEventListener('focus', reload.current); };
  }, [cid]);
  return <section className="skill-selections" aria-label="本会话已选 Skill">
    <div className="selection-heading"><strong>本会话已选 Skill</strong><button onClick={onManage}>管理与选用</button></div>
    {loading && <p role="status">正在读取已选方法…</p>}
    {error && <p className="error" role="alert">已选方法读取失败，暂不能确认当前状态。{error} <button onClick={() => reload.current()}>重试</button></p>}
    {!loading && !error && !items.length && <p className="quiet">尚未选用，可直接提问。</p>}
    {!error && items.map(item => <div key={item.asset_id} className={'skill-selection ' + item.availability}>
      <span><strong>{item.name ?? '不可用的 Skill'}</strong> · 已选 v{item.selected_version}{item.current_version && item.current_version !== item.selected_version && ` / 当前 v${item.current_version}`}</span>
      <small>{item.visibility === 'space' ? '空间公共' : item.visibility === 'personal' ? '个人' : '来源不可访问'} · {labels[item.availability]}</small>
    </div>)}
    {next && !error && <button onClick={() => { pages.current++; reload.current(); }}>加载更多已选方法</button>}
  </section>;
}
