import { useState } from "react";
import { Modal } from "../../shared/Modal.tsx";
import { Icon } from "../../shared/Icon.tsx";
import type { ModelOption, ModelSelection } from "../../../../../packages/contracts/generated/boundary.ts";

export function ModelSelector({ models, selection, disabled, onChange }: {
  models: ModelOption[];
  selection: ModelSelection | null;
  disabled: boolean;
  onChange: (selection: ModelSelection) => void;
}) {
  const [showInfo, setShowInfo] = useState(false);
  if (!models.length || !selection) return null;
  const model = models.find(item => item.id === selection.model_id);
  return <div className="composer-models" aria-label="本次提问的模型设置">
    <select aria-label="模型" title="从下一条发送的消息开始使用" disabled={disabled} value={selection.model_id} onChange={e => {
      const next = models.find(item => item.id === e.target.value);
      if (!next) return;
      const level = next.thinking_options.find(item => item.value === selection.thinking_level)?.value ?? next.thinking_options[0].value;
      onChange({ model_id: next.id, thinking_level: level });
    }}>
      {models.map(item => <option key={item.id} value={item.id}>{item.label.replace(/^DeepSeek\s*/i, "")}</option>)}
    </select>
    <label>思考
      <select aria-label="思考强度" title="较高强度可能需要更多时间和用量" disabled={disabled} value={selection.thinking_level} onChange={e => {
        const option = model?.thinking_options.find(item => item.value === e.target.value);
        if (option) onChange({ ...selection, thinking_level: option.value });
      }}>
        {model?.thinking_options.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
      </select>
    </label>
    <button className="model-info" type="button" aria-label="模型设置说明" onClick={() => setShowInfo(true)}><Icon name="info"/></button>
    {showInfo && <Modal title="模型与思考强度" onClose={() => setShowInfo(false)}><p>从下一条发送的消息开始使用。已经开始的生成和后台查询继续使用原来的设置。</p><p>较高的思考强度通常需要更多等待时间和用量。这里只展示当前模型支持的档位。</p></Modal>}
  </div>;
}
