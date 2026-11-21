use crate::types::{Error, Result};
use ring::{
    aead, hmac,
    rand::{SecureRandom, SystemRandom},
};
use std::{
    fs::{self, File, Metadata, OpenOptions},
    io::{ErrorKind, Read, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    sync::RwLock,
};

#[derive(PartialEq, Eq)]
struct KeyFileIdentity {
    device: u64,
    inode: u64,
    modified: (i64, i64),
    mode: u32,
}

impl KeyFileIdentity {
    fn read(metadata: &Metadata) -> Result<Self> {
        let mode = metadata.mode();
        if !metadata.is_file() || mode & 0o7777 != 0o600 || metadata.len() != 32 {
            return Err(Error::new("model_secret_unavailable"));
        }
        Ok(Self {
            device: metadata.dev(),
            inode: metadata.ino(),
            modified: (metadata.mtime(), metadata.mtime_nsec()),
            mode,
        })
    }
}

struct CachedMasterKey {
    path: PathBuf,
    identity: KeyFileIdentity,
    bytes: [u8; 32],
}

fn master_key(create: bool) -> Result<[u8; 32]> {
    static CACHE: RwLock<Option<CachedMasterKey>> = RwLock::new(None);
    let path = PathBuf::from(
        std::env::var("DATA_AGENT_MODEL_KEY_FILE")
            .unwrap_or_else(|_| ".local/model-configuration.key".into()),
    );
    key_from_file(&CACHE, path, create)
}

fn key_from_file(
    cache: &RwLock<Option<CachedMasterKey>>,
    path: PathBuf,
    create: bool,
) -> Result<[u8; 32]> {
    let metadata = match fs::symlink_metadata(&path) {
        Err(e) if create && e.kind() == ErrorKind::NotFound => {
            create_master_key(&path).and_then(|()| {
                fs::symlink_metadata(&path).map_err(|_| Error::new("model_secret_unavailable"))
            })
        }
        result => result.map_err(|_| Error::new("model_secret_unavailable")),
    };
    let identity = match metadata.and_then(|meta| KeyFileIdentity::read(&meta)) {
        Ok(identity) => identity,
        Err(error) => {
            *cache
                .write()
                .map_err(|_| Error::new("model_secret_unavailable"))? = None;
            return Err(error);
        }
    };
    let cached = cache
        .read()
        .map_err(|_| Error::new("model_secret_unavailable"))?;
    if let Some(key) = cached
        .as_ref()
        .filter(|key| key.path == path && key.identity == identity)
    {
        return Ok(key.bytes);
    }
    drop(cached);

    let mut cached = cache
        .write()
        .map_err(|_| Error::new("model_secret_unavailable"))?;
    if let Some(key) = cached
        .as_ref()
        .filter(|key| key.path == path && key.identity == identity)
    {
        return Ok(key.bytes);
    }
    *cached = None;
    let mut file = File::open(&path).map_err(|_| Error::new("model_secret_unavailable"))?;
    // 文件可能被原子替换；确认读取的文件描述符对应这次检查过的身份。
    if KeyFileIdentity::read(
        &file
            .metadata()
            .map_err(|_| Error::new("model_secret_unavailable"))?,
    )? != identity
    {
        return Err(Error::new("model_secret_unavailable"));
    }
    let mut bytes = [0u8; 32];
    file.read_exact(&mut bytes)
        .map_err(|_| Error::new("model_secret_unavailable"))?;
    *cached = Some(CachedMasterKey {
        path,
        identity,
        bytes,
    });
    Ok(bytes)
}

fn create_master_key(path: &Path) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|_| Error::new("model_secret_unavailable"))?;
    }
    let mut bytes = [0u8; 32];
    SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| Error::new("model_secret_unavailable"))?;
    match OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
    {
        Ok(mut file) => file
            .write_all(&bytes)
            .and_then(|()| file.sync_all())
            .map_err(|_| Error::new("model_secret_unavailable")),
        Err(error) if error.kind() == ErrorKind::AlreadyExists => Ok(()),
        Err(_) => Err(Error::new("model_secret_unavailable")),
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn reloads_replaced_key_and_rejects_unsafe_or_missing_file() -> Result<()> {
        let directory = std::env::temp_dir().join(crate::types::id());
        fs::create_dir(&directory).unwrap();
        let path = directory.join("master.key");
        let renamed = directory.join("rotated.key");
        let cache = RwLock::new(None);
        let before = key_from_file(&cache, path.clone(), true)?;
        let after = key_from_file(&RwLock::new(None), renamed.clone(), true)?;
        assert_ne!(before, after);
        fs::rename(&renamed, &path).unwrap();
        assert_eq!(key_from_file(&cache, path.clone(), false)?, after);

        fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
        assert_eq!(
            key_from_file(&cache, path.clone(), false).unwrap_err().code,
            "model_secret_unavailable"
        );
        assert!(cache.read().unwrap().is_none());
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(key_from_file(&cache, path.clone(), false)?, after);

        fs::remove_file(&path).unwrap();
        assert_eq!(
            key_from_file(&cache, path, false).unwrap_err().code,
            "model_secret_unavailable"
        );
        assert!(cache.read().unwrap().is_none());
        fs::remove_dir(directory).unwrap();
        Ok(())
    }
}
