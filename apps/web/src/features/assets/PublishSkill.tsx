import {useState} from 'react';
import type {Asset} from '../../../../../packages/contracts/generated/boundary.ts';
import {api} from '../../shared/api.ts';
import {Modal} from '../../shared/Modal.tsx';
export function PublishSkill({asset, onClose, onPublished, onFailed}: {asset: Asset; onClose: () => void; onPublished: () => Promise<void>; onFailed: () => void}) {
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [operation] = useState(() => crypto.randomUUID());
  const publish = async () => {
    if (busy || !confirmed) return;
    setBusy(true); setError('');
    try {
      await api('Asset', '/assets/' + asset.id + '/publish', 'POST', {operation_id: operation, expected_version: asset.version, share_confirmed: true});
      await onPublished();
    } catch (e) { onFailed(); setError(e instanceof Error && e.message === 'skill_already_published' ? '此方法已经发布。请到空间公共页维护公共副本。' : e instanceof Error && e.message === 'version_conflict' ? '原方法已变化，请关闭并重新核对最新版本。' : e instanceof Error ? e.message : '发布失败'); }
    finally { setBusy(false); }
  };
  return <Modal title="发布到当前空间" onClose={onClose}>
    <p>以下内容将创建为独立公共副本，你是负责人。后续私人修改不会自动同步。</p>
    <h3>{asset.name} · v{asset.version}</h3><p>{asset.scope}</p><pre className="skill-preview">{asset.body}</pre>
    {(asset.files ?? []).map(file => <details key={file.path}><summary>{file.path}</summary><pre className="skill-preview">{file.content}</pre></details>)}
    <details><summary>将公开的知识引用（{asset.dependencies.length}）</summary><pre>{JSON.stringify(asset.dependencies, null, 2)}</pre></details>
    <p className="quiet">原始来源备注、私人聊天、记忆和查询结果不会自动复制。请确认正文和附件适合当前空间成员查看。</p>
    <label className="checkbox-label"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)}/>我已核对以上公开内容</label>
    {error && <p role="alert" className="error">{error}</p>}
    <button className="primary" disabled={busy || !confirmed} onClick={() => void publish()}>{busy ? '正在发布…' : '确认发布独立副本'}</button>
  </Modal>;
}
