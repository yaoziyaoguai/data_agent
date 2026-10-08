//! 数据库 Skill 到原生文本资源的薄投影；不负责工具循环或读取分页。
use crate::types::{Error, Result, epoch};
use serde_json::{Value, json};
use std::collections::HashSet;

fn validate_lines(text: &str) -> Result<()> {
    // Pi 原生 read 不能对超出 50 KiB 的单行续读；保存时显式拒绝，避免提示使用未开放的 bash。
    if text.split('\n').any(|line| line.len() > 50 * 1024) {
        return Err(Error::new("skill_line_too_long"));
    }
    Ok(())
}

fn allowed_file(path: &str) -> bool {
    let Some((root, rest)) = path.split_once('/') else {
        return false;
    };
    matches!(root, "references" | "assets")
        && rest
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
        && rest
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_-/ .".contains(&c) && c != b' ')
        && [".md", ".txt", ".csv", ".json"]
            .iter()
            .any(|ext| rest.ends_with(ext))
        && !rest.contains("/.")
        && !rest.starts_with('.')
}
pub fn validate(kind: &Value, files: &Value) -> Result<()> {
    let files = files.as_array().ok_or(Error::new("invalid_input"))?;
    if kind != "skill" && !files.is_empty() {
        return Err(Error::new("invalid_input"));
    }
    let mut paths = HashSet::new();
    let mut size = 0;
    for file in files {
        let path = file["path"].as_str().ok_or(Error::new("invalid_input"))?;
        if !allowed_file(path) || !paths.insert(path) {
            return Err(Error::new("invalid_input"));
        }
        let content = file["content"]
            .as_str()
            .ok_or(Error::new("invalid_input"))?;
        validate_lines(content)?;
        size += content.chars().count();
    }
    if size > 160000 {
        return Err(Error::new("invalid_input"));
    }
    Ok(())
}
pub fn location(asset: &Value) -> String {
    format!(
        "/skills/{}/{}/SKILL.md",
        asset["id"].as_str().unwrap_or(""),
        asset["version"].as_str().unwrap_or("")
    )
}
pub fn parse_location(path: &str) -> Result<(&str, &str, &str)> {
    let mut parts = path
        .strip_prefix("/skills/")
        .ok_or(Error::new("not_available"))?
        .splitn(3, '/');
    let asset = parts.next().unwrap_or("");
    let version = parts.next().unwrap_or("");
    let file = parts.next().unwrap_or("");
    if asset.is_empty()
        || !asset
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
        || epoch(version).is_err()
        || (file != "SKILL.md" && !allowed_file(file))
    {
        return Err(Error::new("not_available"));
    }
    Ok((asset, version, file))
}
pub fn descriptor(asset: &Value) -> Value {
    json!({"id":asset["id"],"kind":"skill","name":asset["name"].as_str().unwrap_or("").chars().take(160).collect::<String>(),"body":"","scope":asset["scope"].as_str().unwrap_or("").chars().take(160).collect::<String>(),"version":asset["version"],"state":asset["state"],"verified":asset["verified"],"source_text":"","dependencies":[],"selected":true,"visibility":asset["visibility"],"owner_id":asset["owner_id"],"native_path":location(asset)})
}
pub fn content(asset: &Value, file: &str) -> Result<String> {
    if file == "SKILL.md" {
        let files = asset["files"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|v| format!("- {}", v["path"].as_str().unwrap_or("")))
            .collect::<Vec<_>>()
            .join("\n");
        let text = format!(
            "---\nname: skill-{}\ndescription: {}\n---\n# {}\n\n适用范围：{}\n\n{}\n\n## 配套文本（相对本 Skill 目录）\n{}\n\n## 知识引用\n{}",
            asset["id"]
                .as_str()
                .unwrap_or("")
                .to_lowercase()
                .replace('_', "-"),
            serde_json::to_string(asset["scope"].as_str().unwrap_or("")).unwrap(),
            asset["name"].as_str().unwrap_or(""),
            asset["scope"].as_str().unwrap_or(""),
            asset["body"].as_str().unwrap_or(""),
            files,
            asset["dependencies"]
        );
        validate_lines(&text)?;
        return Ok(text);
    }
    let text = asset["files"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|v| v["path"] == file)
        .and_then(|v| v["content"].as_str())
        .map(str::to_owned)
        .ok_or(Error::new("not_available"))?;
    validate_lines(&text)?;
    Ok(text)
}
