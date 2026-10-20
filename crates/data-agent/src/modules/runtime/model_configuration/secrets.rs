use crate::types::{Error, Result};
use ring::{
    aead, hmac,
    rand::{SecureRandom, SystemRandom},
};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::PathBuf,
};

fn master_key(create: bool) -> Result<Vec<u8>> {
    let path = PathBuf::from(
        std::env::var("DATA_AGENT_MODEL_KEY_FILE")
            .unwrap_or_else(|_| ".local/model-configuration.key".into()),
    );
    if create && !path.exists() {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|_| Error::new("model_secret_unavailable"))?;
        }
        let mut bytes = [0u8; 32];
        SystemRandom::new()
            .fill(&mut bytes)
            .map_err(|_| Error::new("model_secret_unavailable"))?;
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(&path) {
            Ok(mut file) => {
                file.write_all(&bytes)
                    .and_then(|_| file.sync_all())
                    .map_err(|_| Error::new("model_secret_unavailable"))?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => (),
            Err(_) => return Err(Error::new("model_secret_unavailable")),
        }
    }
    let metadata =
        fs::symlink_metadata(&path).map_err(|_| Error::new("model_secret_unavailable"))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(Error::new("model_secret_unavailable"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(Error::new("model_secret_unavailable"));
        }
    }
    let key = fs::read(path).map_err(|_| Error::new("model_secret_unavailable"))?;
    if key.len() != 32 {
        return Err(Error::new("model_secret_unavailable"));
    }
    Ok(key)
}

pub(super) fn request_fingerprint(value: &serde_json::Value, allow_create: bool) -> Result<String> {
    // 请求指纹也含密钥输入，使用带密钥摘要，不能保存可离线猜测的普通哈希。
    let key = hmac::Key::new(hmac::HMAC_SHA256, &master_key(allow_create)?);
    let tag = hmac::sign(
        &key,
        &serde_json::to_vec(value).map_err(|_| Error::new("invalid_input"))?,
    );
    Ok(tag.as_ref().iter().map(|b| format!("{b:02x}")).collect())
}

pub(super) fn seal(secret: &str, identity: &str, allow_create: bool) -> Result<Vec<u8>> {
    let key = aead::LessSafeKey::new(
        aead::UnboundKey::new(&aead::AES_256_GCM, &master_key(allow_create)?)
            .map_err(|_| Error::new("model_secret_unavailable"))?,
    );
    let mut nonce = [0u8; 12];
    SystemRandom::new()
        .fill(&mut nonce)
        .map_err(|_| Error::new("model_secret_unavailable"))?;
    let mut data = secret.as_bytes().to_vec();
    key.seal_in_place_append_tag(
        aead::Nonce::assume_unique_for_key(nonce),
        aead::Aad::from(identity.as_bytes()),
        &mut data,
    )
    .map_err(|_| Error::new("model_secret_unavailable"))?;
    Ok([nonce.to_vec(), data].concat())
}

pub(super) fn open(ciphertext: &[u8], identity: &str) -> Result<String> {
    if ciphertext.len() < 28 {
        return Err(Error::new("model_secret_unavailable"));
    }
    let key = aead::LessSafeKey::new(
        aead::UnboundKey::new(&aead::AES_256_GCM, &master_key(false)?)
            .map_err(|_| Error::new("model_secret_unavailable"))?,
    );
    let nonce = aead::Nonce::try_assume_unique_for_key(&ciphertext[..12])
        .map_err(|_| Error::new("model_secret_unavailable"))?;
    let mut data = ciphertext[12..].to_vec();
    let plain = key
        .open_in_place(nonce, aead::Aad::from(identity.as_bytes()), &mut data)
        .map_err(|_| Error::new("model_secret_unavailable"))?;
    String::from_utf8(plain.to_vec()).map_err(|_| Error::new("model_secret_unavailable"))
}
