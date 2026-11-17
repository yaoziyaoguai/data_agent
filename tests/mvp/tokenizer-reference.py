"""用官方数据和encoder字面量独立核验实际维护请求；不调用模型或执行下载代码。"""
import ast
import hashlib
import json
from pathlib import Path
import sys

from tokenizers import Tokenizer

root = Path(__file__).resolve().parents[2]
assets = root / "crates/data-agent/resources/deepseek"
manifest = json.loads((assets / "manifest.json").read_text())
request = json.load(sys.stdin)
model = manifest["models"][request["model"]]
source = (assets / model["encoder_reference"]).read_bytes()
assert hashlib.sha256(source).hexdigest() == model["encoder_sha256"]
values = {}
for node in ast.parse(source).body:
    name, value = None, None
    if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
        name, value = node.targets[0].id, node.value
    elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
        name, value = node.target.id, node.value
    if name:
        try:
            values[name] = ast.literal_eval(value)
        except (ValueError, TypeError):
            pass

assert [message["role"] for message in request["messages"]] == ["system", "user"]
assert len(request["tools"]) == 1
flash = request["model"] == "deepseek-flash"
thinking = request["thinking"]["type"] == "enabled"
mode = request.get("reasoning_effort", values["DEFAULT_REASONING_EFFORT"]) if thinking else "off"
effort = ""
if thinking:
    if flash:
        effort = values["REASONING_EFFORT_TEMPLATE"].format(budget=values["REASONING_EFFORT_MAPPINGS"][mode])
    else:
        effort = values["REASONING_EFFORT_PROMPTS"][mode]
substitutions = {key: values[key] for key in ("dsml_token", "thinking_start_token", "thinking_end_token")}
if flash:
    substitutions.update(tc_block_name=values["tool_calls_block_name"],
                         tool_call_tag_name=values["tool_call_tag_name"],
                         tool_parameter_tag_name=values["tool_parameter_tag_name"])
function = json.dumps(request["tools"][0]["function"], ensure_ascii=False)
tools = values["TOOLS_TEMPLATE"].format(tool_schemas=function, **substitutions)
prompt = (values["bos_token"] + values.get("SYSTEM_SP_TOKEN", "") + effort
          + request["messages"][0]["content"] + "\n\n" + tools
          + values["USER_SP_TOKEN"] + request["messages"][1]["content"]
          + values["ASSISTANT_SP_TOKEN"]
          + values["thinking_start_token" if thinking else "thinking_end_token"])
tokenizer_bytes = (assets / model["tokenizer"]).read_bytes()
assert hashlib.sha256(tokenizer_bytes).hexdigest() == model["tokenizer_sha256"]
tokenizer = Tokenizer.from_str(tokenizer_bytes.decode("utf-8"))
encoded = tokenizer.encode(prompt, add_special_tokens=False)
print(json.dumps({"tokens": len(encoded.ids), "prompt_bytes": len(prompt.encode("utf-8")),
                  "tokenizer_sha256": model["tokenizer_sha256"],
                  "encoder_sha256": model["encoder_sha256"]}))
