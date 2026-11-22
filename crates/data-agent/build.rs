use std::{env, fs, io, path::PathBuf};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path =
        PathBuf::from(env::var("CARGO_MANIFEST_DIR")?).join("../../infra/embedding-model.json");
    println!("cargo:rerun-if-changed={}", path.display());
    let spec: serde_json::Value = serde_json::from_slice(&fs::read(&path)?)?;
    let string = |key: &str| {
        spec[key].as_str().ok_or_else(|| {
            io::Error::other(format!(
                "embedding specification field {key} must be a string"
            ))
        })
    };
    let number = |key: &str| {
        spec[key].as_u64().ok_or_else(|| {
            io::Error::other(format!(
                "embedding specification field {key} must be an unsigned integer"
            ))
        })
    };
    let source = format!(
        "ModelSpec {{ model_id: {:?}.into(), dimension: {}, version: {:?}.into(), endpoint: {:?}.into(), batch_limit: {}, input_bytes_limit: {} }}",
        string("model_id")?,
        number("dimension")?,
        string("version")?,
        string("endpoint")?,
        number("batch_limit")?,
        number("input_bytes_limit")?,
    );
    fs::write(
        PathBuf::from(env::var("OUT_DIR")?).join("embedding_spec.rs"),
        source,
    )?;
    Ok(())
}
