use crate::{
    contracts::generated::{ModelProfile, ThinkingLevel},
    types::{Error, Result},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs, io,
    path::{Path, PathBuf},
    sync::OnceLock,
};
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
    fn load(
        directory: &Path,
        model: &str,
        tokenizer_sha256: &str,
        format_sha256: &str,
    ) -> std::result::Result<Self, String> {
        let tokenizer = verified_asset(
            &directory.join(format!("{model}-tokenizer.json")),
            tokenizer_sha256,
        )?;
        let format = verified_asset(
            &directory.join(format!("{model}-format.json")),
            format_sha256,
        )?;
        Ok(Self {
            tokenizer: Tokenizer::from_bytes(&tokenizer)
                .map_err(|error| format!("Invalid {model} tokenizer: {error}"))?,
            format: serde_json::from_slice(&format)
                .map_err(|error| format!("Invalid {model} prompt format: {error}"))?,
        })
    }
}

fn verified_asset(path: &Path, sha256: &str) -> std::result::Result<Vec<u8>, String> {
    let bytes = fs::read(path)
        .map_err(|error| format!("Cannot read model resource {}: {error}", path.display()))?;
    if format!("{:x}", Sha256::digest(&bytes)) != sha256 {
        return Err(format!(
            "Unexpected SHA-256 for model resource {}",
            path.display()
        ));
    }
    Ok(bytes)
}

fn encoding_directory() -> PathBuf {
    if let Some(directory) = std::env::var_os("DATA_AGENT_RESOURCES_DIR") {
        return PathBuf::from(directory).join("deepseek");
    }
    if let Ok(executable) = std::env::current_exe()
        && let Some(parent) = executable.parent()
    {
        let packaged = parent.join("resources/deepseek");
        if packaged.is_dir() {
            return packaged;
        }
    }
    Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/deepseek")
}

static FLASH: OnceLock<ModelEncoding> = OnceLock::new();
static PRO: OnceLock<ModelEncoding> = OnceLock::new();

fn load_encoding(
    cache: &OnceLock<ModelEncoding>,
    load: impl FnOnce() -> std::result::Result<ModelEncoding, String>,
) -> Result<&ModelEncoding> {
    if let Some(encoding) = cache.get() {
        return Ok(encoding);
    }
    let encoding = load().map_err(|problem| Error::new("unavailable").with_message(problem))?;
    Ok(cache.get_or_init(|| encoding))
}

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
        "deepseek-flash" => load_encoding(&FLASH, || {
            ModelEncoding::load(
                &encoding_directory(),
                "flash",
                "c90dfa01249db1be4245780a052ede752e1361c612ac6d08e2bdada7d599476b",
                "47ba348f139492c8e7fcd08fa52e6f25c591c2a7ac6f8fd47ff24f99665628df",
            )
        }),
        "deepseek-v4-pro" => load_encoding(&PRO, || {
            ModelEncoding::load(
                &encoding_directory(),
                "pro",
                "8f9f37ca37fdc4f5fd36d5cf4d3b0e8392edb4e894fd10cc0d70b4957c8633cf",
                "2fe4bc210bce9bd7902524d68d9240bce2913b0f35e68c594f4a4f94b9f70811",
            )
        }),
        _ => Err(Error::new("invalid_input")),
    }?;
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
    let schema = String::from_utf8(schema)
        .map_err(|error| Error::new("unavailable").with_message(error.to_string()))?;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokenizer_load_can_recover_after_a_missing_resource() {
        let directory = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/deepseek");
        let load = |path: &Path| {
            ModelEncoding::load(
                path,
                "flash",
                "c90dfa01249db1be4245780a052ede752e1361c612ac6d08e2bdada7d599476b",
                "47ba348f139492c8e7fcd08fa52e6f25c591c2a7ac6f8fd47ff24f99665628df",
            )
        };
        let cache = OnceLock::new();
        let missing = directory.join("missing");
        assert!(load_encoding(&cache, || load(&missing)).is_err());
        assert!(load_encoding(&cache, || load(&directory)).is_ok());
        assert!(load_encoding(&cache, || load(&missing)).is_ok());
    }

    #[test]
    fn tokenizer_assets_are_verified_before_parsing() {
        let directory = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/deepseek");
        let format = directory.join("flash-format.json");
        let bytes = verified_asset(
            &format,
            "47ba348f139492c8e7fcd08fa52e6f25c591c2a7ac6f8fd47ff24f99665628df",
        )
        .unwrap();
        assert!(!bytes.is_empty());
        assert!(
            verified_asset(&format, "bad-checksum")
                .unwrap_err()
                .contains("Unexpected SHA-256")
        );
        assert!(
            verified_asset(&format.join("missing"), "bad-checksum")
                .unwrap_err()
                .contains("Cannot read model resource")
        );
    }
}
