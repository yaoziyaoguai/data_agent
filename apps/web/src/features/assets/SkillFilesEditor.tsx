import type { SkillFile } from '../../../../../packages/contracts/generated/boundary.ts';
export function SkillFilesEditor({files, onChange, disabled = false}: {files: SkillFile[]; onChange: (files: SkillFile[]) => void; disabled?: boolean}) {
  return <fieldset disabled={disabled} className="skill-files"><legend>配套说明与模板</legend>
    <p className="quiet">可以附上报告样式、字段说明或分析示例。支持 Markdown、纯文本、CSV 和 JSON；附件使用英文文件名，例如 report.md。</p>
    {files.map((file, index) => <div key={index} className="skill-file-editor">
      <label className="form-label">附件名称<input value={file.path.replace(/^(references|assets)\//, '')} placeholder="report.md" onChange={e => { const value = e.target.value; const folder = file.path.startsWith('assets/') ? 'assets/' : 'references/'; onChange(files.map((v, i) => i === index ? {...v, path: /^(references|assets)\//.test(value) ? value : folder + value} : v)); }}/></label>
      <label className="form-label">文件内容<textarea aria-label="文件内容" rows={5} value={file.content} onChange={e => onChange(files.map((v, i) => i === index ? {...v, content: e.target.value} : v))}/></label>
      <button type="button" onClick={() => onChange(files.filter((_, i) => i !== index))}>移除此附件</button>
    </div>)}
    <button type="button" disabled={files.length >= 12} onClick={() => onChange([...files, {path: '', content: ''}])}>添加文本附件</button>
  </fieldset>;
}
