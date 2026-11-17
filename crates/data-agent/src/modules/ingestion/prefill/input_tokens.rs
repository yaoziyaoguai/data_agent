use crate::{
    contracts::generated::{ModelProfile, ThinkingLevel},
    types::{Error, Result},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::BTreeMap, io, sync::LazyLock};
use tokenizers::Tokenizer;

#[derive(Deserialize)]
struct PromptFormat {
    modes: BTreeMap<String, [String; 4]>,
}

struct ModelEncoding {
    tokenizer: Tokenizer,
    format: PromptFormat,
}

impl ModelEncoding {
    fn load(tokenizer: &[u8], format: &[u8]) -> Self {
        // 编译期固定的MIT资产由完整材料检查核对指纹，不接受部署时的任意替换。
        Self {
            tokenizer: Tokenizer::from_bytes(tokenizer).expect("pinned DeepSeek tokenizer"),
            format: serde_json::from_slice(format).expect("pinned DeepSeek prompt format"),
        }
    }
}

static FLASH: LazyLock<ModelEncoding> = LazyLock::new(|| {
    ModelEncoding::load(
        include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/resources/deepseek/flash-tokenizer.json"
        )),
        include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/resources/deepseek/flash-format.json"
        )),
    )
});
static PRO: LazyLock<ModelEncoding> = LazyLock::new(|| {
    ModelEncoding::load(
        include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/resources/deepseek/pro-tokenizer.json"
        )),
        include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/resources/deepseek/pro-format.json"
        )),
    )
});

// 公开encoder用Python默认JSON分隔符；仅改变结构空格，不改写字段/正文/Unicode。
struct PythonSeparators;
impl serde_json::ser::Formatter for PythonSeparators {
    fn begin_array_value<W: ?Sized + io::Write>(
        &mut self,
        writer: &mut W,
        first: bool,
    ) -> io::Result<()> {
        if first {
            Ok(())
        } else {
            writer.write_all(b", ")
        }
    }
    fn begin_object_key<W: ?Sized + io::Write>(
        &mut self,
        writer: &mut W,
        first: bool,
    ) -> io::Result<()> {
        if first {
            Ok(())
        } else {
            writer.write_all(b", ")
        }
    }
    fn begin_object_value<W: ?Sized + io::Write>(&mut self, writer: &mut W) -> io::Result<()> {
        writer.write_all(b": ")
    }
}

// 按固定的 Flash-1017 / Pro-0813 分词器与公开 chat/function 模板在本地估计输入 token 数，
// 作为维护分片与发送前的局部计量门，不宣称构成托管 API 的无条件服务端上界。
pub(super) fn published_input_tokens(
    profile: &ModelProfile,
    system: &str,
    user: &str,
    function: &Value,
) -> Result<usize> {
    let encoding = match profile.model_id.as_str() {
        "deepseek-flash" => &*FLASH,
        "deepseek-v4-pro" => &*PRO,
        _ => return Err(Error::new("invalid_input")),
    };
    let mode = match profile.thinking_level.as_ref() {
        None | Some(ThinkingLevel::Off) => "off",
        Some(ThinkingLevel::Low) => "low",
        Some(ThinkingLevel::High) => "high",
        Some(ThinkingLevel::Max) => "max",
        _ => return Err(Error::new("invalid_input")),
    };
    let parts = encoding
        .format
        .modes
        .get(mode)
        .ok_or(Error::new("invalid_input"))?;
    let mut schema = Vec::new();
    function
        .serialize(&mut serde_json::Serializer::with_formatter(
            &mut schema,
            PythonSeparators,
        ))
        .map_err(|_| Error::new("invalid_input"))?;
    let schema = String::from_utf8(schema).expect("JSON is UTF-8");
    // 一次编码完整公开prompt，不能把各段独立分词相加而漏掉跨边界的BPE行为。
    let prompt = format!(
        "{}{system}{}{schema}{}{user}{}",
        parts[0], parts[1], parts[2], parts[3]
    );
    let encoded = encoding
        .tokenizer
        .encode(prompt, false)
        .map_err(|_| Error::new("invalid_input"))?;
    Ok(encoded.get_ids().len())
}
