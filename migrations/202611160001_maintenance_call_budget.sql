-- runtime保存本调用的原profile与计费边界；旧issued/unknown保留NULL，不回填或改变占用。
ALTER TABLE maintenance_model_calls ADD COLUMN budget_json JSON NULL;
