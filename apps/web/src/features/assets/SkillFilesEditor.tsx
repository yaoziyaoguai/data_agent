import type { SkillFile } from '../../../../../packages/contracts/generated/boundary.ts';
export function SkillFilesEditor({files, onChange, disabled = false}: {files: SkillFile[]; onChange: (files: SkillFile[]) => void; disabled?: boolean}) {
  return <fieldset disabled={disabled} className="skill-files"><legend>配套说明与模板</legend>
    <p className="quiet">使用 references/ 或 assets/ 下的 .md、.txt、.csv、.json 文本；附件随方法一起保存版本。</p>
    {files.map((file, index) => <div key={index} className="skill-file-editor">
      <label className="form-label">文件路径<input value={file.path} placeholder="references/guide.md" onChange={e => onChange(files.map((v, i) => i === index ? {...v, path: e.target.value} : v))}/></label>
      <label className="form-label">文件内容<textarea aria-label="文件内容" rows={5} value={file.content} onChange={e => onChange(files.map((v, i) => i === index ? {...v, content: e.target.value} : v))}/></label>
      <button type="button" onClick={() => onChange(files.filter((_, i) => i !== index))}>移除此附件</button>
    </div>)}
    <button type="button" disabled={files.length >= 12} onClick={() => onChange([...files, {path: '', content: ''}])}>添加文本附件</button>
  </fieldset>;
}
