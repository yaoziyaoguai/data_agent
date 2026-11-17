export function seedRawAllowedSources(h) {
  const space = "raw-allowed-scope";
  for (const [id, ownerSpace, current, currentComplete, snapshotComplete, retired] of [
    ["raw-allowed-current", space, 3, true, null, false],
    ["raw-allowed-legacy", space, null, null, true, false],
    ["raw-allowed-incomplete", space, 3, false, true, false],
    ["raw-allowed-retired", space, 3, true, true, true],
    ["raw-allowed-missing", space, null, null, null, false],
    ["raw-allowed-old-current", space, 2, false, true, false],
    ["raw-allowed-other-space", "raw-other-space", 3, true, true, false],
  ]) {
    h.sql(`INSERT INTO source_heads(id,space_id,version,fingerprint) VALUES('${id}','${ownerSpace}',3,'synthetic');`);
    if (current !== null) h.sql(`INSERT INTO source_current(source_id,space_id,adapter_id,source_kind,namespace,external_id,revision,body,complete,metadata,content_fingerprint,explanation_fingerprint,comparison_method,parsed,observed_metadata) VALUES('${id}','${ownerSpace}','synthetic','platform','raw-allowed','${id}',${current},REPEAT('合成正文。',20000),${Number(currentComplete)},'{}','synthetic','synthetic','exact',TRUE,'{}');`);
    if (snapshotComplete !== null) h.sql(`INSERT INTO source_snapshots(source_id,version,body,complete) VALUES('${id}',3,REPEAT('合成旧文。',20000),${Number(snapshotComplete)});`);
    if (retired) h.sql(`INSERT INTO catalog_platform_heads(source_id,platform_version,retired) VALUES('${id}',1,TRUE);`);
  }
}
