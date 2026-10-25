use data_agent::modules::ingestion::catalog;
use std::time::Duration;

#[tokio::test]
async fn catalog_transport_preserves_complete_objects_and_rejects_byte_overflow() {
    let expanded = catalog::fetch_page(Some("expanded_table"), None)
        .await
        .unwrap();
    assert_eq!(
        expanded["tables"][0]["columns"].as_array().unwrap().len(),
        201
    );
    assert_eq!(
        expanded["tables"][0]["node"]["sql"]
            .as_str()
            .unwrap()
            .chars()
            .count(),
        40_001
    );
    for case in ["source_below_limit", "source_at_limit"] {
        let page = catalog::fetch_page(Some(case), None).await.unwrap();
        assert_eq!(page["complete"], true);
        assert_eq!(page["tables"].as_array().unwrap().len(), 1);
        let size = serde_json::to_vec(&page["tables"][0]).unwrap().len();
        assert_eq!(
            size,
            if case == "source_at_limit" {
                8_388_608
            } else {
                8_388_607
            }
        );
        assert!(
            page["tables"][0]["node"]["sql"]
                .as_str()
                .unwrap()
                .contains('中')
        );
    }
    let large = catalog::fetch_page(Some("page_at_limit"), None)
        .await
        .unwrap();
    assert_eq!(large["tables"].as_array().unwrap().len(), 2);
    for case in [
        "source_over_limit",
        "page_over_limit",
        "upstream_source_over_limit",
    ] {
        let error = catalog::fetch_page(Some(case), None).await.unwrap_err();
        assert_eq!(error.code, "payload_limit", "{case}");
        let message = error.message.unwrap_or_default();
        assert!(message.contains(if case == "page_over_limit" {
            "16777216"
        } else {
            "8388608"
        }));
        assert!(message.contains(if case == "page_over_limit" {
            "16777217"
        } else {
            "8388609"
        }));
    }
    // 服务故意不结束响应；超限应在读到边界时拒绝，不能等全部下载或10秒请求超时。
    for case in ["oversized_content_length", "oversized_chunked"] {
        let result = tokio::time::timeout(
            Duration::from_secs(5),
            catalog::fetch_page(Some(case), None),
        )
        .await
        .expect("超过字节边界后应停止读取，而不是等待响应结束");
        assert_eq!(result.unwrap_err().code, "payload_limit", "{case}");
    }
    let truncated = catalog::fetch_page(Some("truncated_json"), None)
        .await
        .unwrap_err();
    assert_eq!(truncated.code, "invalid_input");
}
