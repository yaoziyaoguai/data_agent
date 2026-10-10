import {useEffect, useRef, useState} from 'react';
import type {Asset, SkillSuggestion} from '../../../../../packages/contracts/generated/boundary.ts';
import {api} from '../../shared/api.ts';
import {useNavigationGuard, useUnsavedChanges} from '../../shared/UnsavedChanges.tsx';
import {Modal} from '../../shared/Modal.tsx';
function ReviewSuggestion({asset, suggestion, onReviewed}: {asset: Asset; suggestion: SkillSuggestion; onReviewed: () => Promise<void>}) {
  const [response, setResponse] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useUnsavedChanges(Boolean(response), () => setResponse(''));
  const operation = useRef({key: '', id: ''});
  const review = async (state: 'handled' | 'rejected') => {
    if (busy || !response.trim()) return;
    const key = JSON.stringify([suggestion.revision, response, state]);
    if (operation.current.key !== key) operation.current = {key, id: crypto.randomUUID()};
    setBusy(true); setError('');
    try {
      await api('SkillSuggestion', `/assets/${asset.id}/suggestions/${suggestion.id}/review`, 'POST', {operation_id: operation.current.id, expected_revision: suggestion.revision, state, response});
      setResponse(''); await onReviewed();
    } catch (e) { setError(e instanceof Error ? e.message : '处理失败'); }
    finally { setBusy(false); }
  };
  return <div><label className="form-label">处理说明<textarea rows={2} value={response} onChange={e => setResponse(e.target.value)}/></label>
    <div className="actions"><button disabled={busy || !response.trim()} onClick={() => void review('handled')}>标记已处理</button><button disabled={busy || !response.trim()} onClick={() => void review('rejected')}>驳回建议</button></div>
    <p className="quiet">处理建议不会更改方法正文；需要修改时请另行编辑并保存。</p>{error && <p role="alert">{error}</p>}
  </div>;
}
export function SkillSuggestions({asset, onClose}: {asset: Asset; onClose: () => void}) {
  const [items, setItems] = useState<SkillSuggestion[]>([]);
  const [after, setAfter] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useUnsavedChanges(Boolean(content), onClose);
  const leave = useNavigationGuard();
  const generation = useRef(0);
  const operation = useRef({key: '', id: ''});
  const refresh = async (cursor?: string) => {
    const version = ++generation.current;
    const page = await api('SkillSuggestionList', '/assets/' + asset.id + '/suggestions' + (cursor ? '?after_id=' + cursor : ''));
    if (version === generation.current) { setItems(old => cursor ? [...old, ...page.suggestions] : page.suggestions); setAfter(page.next_after_id); }
  };
  useEffect(() => { void refresh().catch(e => setError(e.message)); return () => { generation.current++; }; }, [asset.id]);
  const submit = async () => {
    if (busy || !confirmed || !content.trim()) return;
    const key = JSON.stringify([asset.version, content]);
    if (operation.current.key !== key) operation.current = {key, id: crypto.randomUUID()};
    setBusy(true); setError('');
    try {
      await api('SkillSuggestion', '/assets/' + asset.id + '/suggestions', 'POST', {operation_id: operation.current.id, expected_version: asset.version, content, share_confirmed: true});
      operation.current = {key: '', id: ''};
      setContent(''); setConfirmed(false); await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : '提交失败'); }
    finally { setBusy(false); }
  };
  return <Modal title={'修改建议 · ' + asset.name} onClose={() => { if (!busy) leave(onClose); }}>
    <p>建议向当前空间成员公开；负责人核对后另行修改正文。</p>
    <label className="form-label">你的建议<textarea disabled={busy} rows={4} maxLength={8000} value={content} onChange={e => setContent(e.target.value)}/></label>
    <label className="checkbox-label"><input disabled={busy} type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)}/>确认内容可在当前空间共享</label>
    <button className="primary" disabled={busy || !confirmed || !content.trim()} onClick={() => void submit()}>提交修改建议</button>
    {error && <p className="error" role="alert">{error}<button onClick={() => void refresh().then(() => setError('')).catch(e => setError(e.message))}>刷新建议</button></p>}
    {items.map(item => <article key={item.id} className="skill-suggestion"><strong>{item.author_id} 的建议</strong><p className="entry-value">{item.content}</p><small>{item.state === 'pending' ? '待处理' : item.state === 'handled' ? '已处理' : '已驳回'}</small>
      {item.response && <p>{item.reviewed_by}：{item.response}</p>}
      {asset.can_edit && item.state === 'pending' && <ReviewSuggestion asset={asset} suggestion={item} onReviewed={refresh}/>}
    </article>)}
    {after && <button onClick={() => void refresh(after).catch(e => setError(e.message))}>加载更多建议</button>}
  </Modal>;
}
