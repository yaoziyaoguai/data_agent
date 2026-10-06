use crate::types::{Error, Result, fingerprint};
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::LazyLock;

#[derive(Deserialize)]
pub struct ModelSpec {
    pub model_id: String,
    pub dimension: usize,
    pub version: String,
    pub endpoint: String,
    pub batch_limit: usize,
    pub input_bytes_limit: usize,
}
pub static SPEC: LazyLock<ModelSpec> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../../../../infra/embedding-model.json"))
        .expect("fixed embedding specification")
});

// 百炼usage包含输入模板等开销，短问句也可能超过正文UTF-8字节数。
// 每条预留64 tokens；该估算仍由真实usage核验，超限保留费用并熔断。
const TOKEN_OVERHEAD_PER_TEXT: usize = 64;

pub struct PreparedEmbedding {
    pub payload: Value,
    pub fingerprint: String,
    pub input_upper: u64,
    client: reqwest::Client,
    url: reqwest::Url,
    key: String,
}

pub fn prepare(texts: &[String]) -> Result<PreparedEmbedding> {
    let upper: usize = texts
        .iter()
        .map(|s| s.len() + TOKEN_OVERHEAD_PER_TEXT)
        .sum();
    if texts.is_empty()
        || texts.len() > SPEC.batch_limit
        || upper == 0
        || upper > SPEC.input_bytes_limit
        || texts.iter().any(String::is_empty)
    {
        return Err(Error::new("payload_limit"));
    }
    let endpoint =
        std::env::var("DATA_AGENT_EMBEDDING_URL").unwrap_or_else(|_| SPEC.endpoint.clone());
    let url = reqwest::Url::parse(&endpoint).map_err(|_| Error::new("embedding_unconfigured"))?;
    let local_test = std::env::var("DATA_AGENT_EMBEDDING_TEST").as_deref() == Ok("1")
        && std::env::var("DATA_AGENT_MODE").as_deref() == Ok("development")
        && url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port().is_some();
    if (!local_test && endpoint != SPEC.endpoint)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(Error::new("embedding_unconfigured"));
    }
    let key = if local_test {
        "synthetic-embedding-key".to_owned()
    } else {
        let file = std::env::var("DATA_AGENT_EMBEDDING_KEY_FILE")
            .map_err(|_| Error::new("embedding_unconfigured"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let metadata =
                std::fs::metadata(&file).map_err(|_| Error::new("embedding_unconfigured"))?;
            if metadata.permissions().mode() & 0o077 != 0 {
                return Err(Error::new("embedding_unconfigured"));
            }
        }
        std::fs::read_to_string(file)
            .map_err(|_| Error::new("embedding_unconfigured"))?
            .trim()
            .to_owned()
    };
    if key.is_empty() {
        return Err(Error::new("embedding_unconfigured"));
    }
    let payload = json!({"model":SPEC.model_id,"input":texts,"dimensions":SPEC.dimension,"encoding_format":"float"});
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|_| Error::new("embedding_unavailable"))?;
    Ok(PreparedEmbedding {
        fingerprint: fingerprint(&json!([SPEC.version, endpoint, payload])),
        payload,
        input_upper: upper as u64,
        client,
        url,
        key,
    })
}

impl PreparedEmbedding {
    // 无SDK隐式重试；外发失败交给宿主保存unknown，不能换调用ID重发。
    pub async fn send(&self) -> Result<Value> {
        let mut response = self
            .client
            .post(self.url.clone())
            .bearer_auth(&self.key)
            .json(&self.payload)
            .send()
            .await
            .map_err(|_| Error::new("embedding_unknown"))?;
        if !response.status().is_success()
            || response.content_length().is_some_and(|n| n > 2_000_000)
        {
            return Err(Error::new("embedding_unknown"));
        }
        let mut body = Vec::new();
        while let Some(part) = response
            .chunk()
            .await
            .map_err(|_| Error::new("embedding_unknown"))?
        {
            if body.len() + part.len() > 2_000_000 {
                return Err(Error::new("embedding_unknown"));
            }
            body.extend_from_slice(&part);
        }
        serde_json::from_slice(&body).map_err(|_| Error::new("embedding_unknown"))
    }
}

pub fn usage(value: &Value, elapsed_ms: u64) -> Option<Value> {
    let tokens = value["usage"]["prompt_tokens"]
        .as_u64()
        .or_else(|| value["usage"]["total_tokens"].as_u64())?;
    if tokens > 100_000_000 {
        return None;
    }
    Some(json!({"input_tokens":tokens,"output_tokens":0,"elapsed_ms":elapsed_ms.min(120000)}))
}

pub fn vectors(value: &Value, count: usize) -> Result<Vec<Vec<f32>>> {
    let items = value["data"]
        .as_array()
        .ok_or(Error::new("embedding_unavailable"))?;
    if items.len() != count {
        return Err(Error::new("embedding_unavailable"));
    }
    let mut result = vec![None; count];
    for item in items {
        let index = item["index"]
            .as_u64()
            .filter(|v| *v < (count as u64))
            .ok_or(Error::new("embedding_unavailable"))? as usize;
        let values = item["embedding"]
            .as_array()
            .ok_or(Error::new("embedding_unavailable"))?;
        if result[index].is_some() || values.len() != SPEC.dimension {
            return Err(Error::new("embedding_unavailable"));
        }
        let raw: Vec<f64> = values
            .iter()
            .map(|v| {
                v.as_f64()
                    .filter(|v| v.is_finite())
                    .ok_or(Error::new("embedding_unavailable"))
            })
            .collect::<Result<_>>()?;
        let norm = raw.iter().map(|v| v * v).sum::<f64>().sqrt();
        if !norm.is_finite() || norm == 0. {
            return Err(Error::new("embedding_unavailable"));
        }
        result[index] = Some(raw.into_iter().map(|v| (v / norm) as f32).collect());
    }
    result
        .into_iter()
        .map(|v| v.ok_or(Error::new("embedding_unavailable")))
        .collect()
}

// 按固定文本顺序分批，重试不根据临时pending集合重新组合付费请求。
pub fn batches(pieces: &[Value]) -> Result<Vec<&[Value]>> {
    let mut batches = Vec::new();
    let mut start = 0;
    let mut bytes = 0;
    for (i, piece) in pieces.iter().enumerate() {
        let size = piece["text"]
            .as_str()
            .ok_or(Error::new("invalid_input"))?
            .len();
        if size == 0 || size + TOKEN_OVERHEAD_PER_TEXT > SPEC.input_bytes_limit {
            return Err(Error::new("payload_limit"));
        }
        let size = size + TOKEN_OVERHEAD_PER_TEXT;
        if i - start == SPEC.batch_limit || bytes + size > SPEC.input_bytes_limit {
            batches.push(&pieces[start..i]);
            start = i;
            bytes = 0;
        }
        bytes += size;
    }
    if start < pieces.len() {
        batches.push(&pieces[start..]);
    }
    Ok(batches)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn response_order_is_checked_and_vectors_are_normalized() {
        let mut vector = vec![0.; SPEC.dimension];
        vector[0] = 3.;
        vector[1] = 4.;
        let value = json!({"data":[{"index":1,"embedding":vector},{"index":0,"embedding":vector}]});
        let found = vectors(&value, 2).unwrap();
        assert_eq!(found.len(), 2);
        assert!((found[0][0] - 0.6).abs() < 0.00001);
        assert_eq!(
            vectors(&json!({"data":[{"index":0,"embedding":[1.,2.]}]}), 1)
                .unwrap_err()
                .code,
            "embedding_unavailable"
        );
        let mut duplicate = value.clone();
        duplicate["data"][1]["index"] = json!(1);
        assert!(vectors(&duplicate, 2).is_err());
        assert!(
            vectors(
                &json!({"data":[{"index":0,"embedding":vec![0.;SPEC.dimension]}]}),
                1
            )
            .is_err()
        );
        assert!(usage(&json!({"usage":{"total_tokens":-1}}), 1).is_none());
        assert_eq!(
            usage(&json!({"usage":{"total_tokens":13}}), 1).unwrap()["input_tokens"],
            13
        );
    }
    #[test]
    fn utf8_batches_preserve_order_and_enforce_request_bounds() {
        let pieces = (0..32)
            .map(|i| json!({"id":i,"text":"中文".repeat(200)}))
            .collect::<Vec<_>>();
        let groups = batches(&pieces).unwrap();
        assert_eq!(groups.iter().map(|g| g.len()).sum::<usize>(), 32);
        assert!(groups.iter().all(|g| {
            g.len() <= 20
                && g.iter()
                    .map(|p| p["text"].as_str().unwrap().len() + TOKEN_OVERHEAD_PER_TEXT)
                    .sum::<usize>()
                    <= 8192
        }));
        assert_eq!(
            groups
                .iter()
                .flat_map(|g| g.iter())
                .map(|p| p["id"].as_u64().unwrap())
                .collect::<Vec<_>>(),
            (0..32).collect::<Vec<_>>()
        );
        assert!(batches(&[json!({"text":"中".repeat(3000)})]).is_err());
    }
}
