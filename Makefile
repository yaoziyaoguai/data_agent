.PHONY: setup-node setup-rust verify verify-materials verify-delivery verify-increment verify-fixture verify-node verify-rust verify-browser verify-infra infra-up infra-down infra-status vm-stop prototype

PYTHON ?= python3
NPM ?= npm
CARGO ?= $(HOME)/.cargo/bin/cargo

setup-node:
	$(NPM) ci --engine-strict --no-audit --no-fund
	$(NPM) run browser:install

setup-rust:
	$(CARGO) fetch --locked

verify: verify-materials verify-delivery verify-fixture verify-node verify-rust

verify-materials:
	$(PYTHON) scripts/check_preparation.py

verify-delivery:
	$(PYTHON) scripts/check_delivery.py
	$(PYTHON) -m unittest discover -s scripts -p 'test_check_delivery.py'

verify-increment:
	$(PYTHON) scripts/check_delivery.py --complete

verify-fixture:
	$(PYTHON) docs/sources/verify.py
	$(PYTHON) docs/sources/cockpit/verify.py

verify-node:
	$(NPM) run check:node

verify-rust:
	$(CARGO) fmt --all --check
	$(CARGO) clippy --offline --locked --all-targets -- -D warnings
	$(CARGO) run --quiet --offline --locked -p data-agent-env-check

verify-browser:
	$(NPM) run check:browser

verify-infra:
	$(PYTHON) scripts/check-infra.py
	$(CARGO) run --quiet --offline --locked -p data-agent-env-check -- --mysql

infra-up:
	$(PYTHON) scripts/infra.py up

infra-down:
	$(PYTHON) scripts/infra.py down

infra-status:
	$(PYTHON) scripts/infra.py status

vm-stop:
	$(PYTHON) scripts/infra.py vm-stop

prototype:
	$(PYTHON) -m http.server 8765 --bind 127.0.0.1 --directory prototype

.PHONY: build dev verify-contracts verify-runtime-flow verify-recovery verify-architecture verify-code verify-startup

build:
	$(CARGO) build --offline --locked --workspace
	$(NPM) run build:web

dev: build
	$(PYTHON) scripts/development.py

verify-startup: build
	$(PYTHON) -m unittest discover -s scripts -p 'test_development.py'
	$(PYTHON) scripts/development.py --check
	node tests/mvp/check-model-startup.mjs

.PHONY: verify-pi-transport
verify-pi-transport:
	node tests/runtime/check-data-tool-transport.mjs --diagnose-validation
	node tests/runtime/check-tool-serialization.mjs
	node tests/runtime/check-evidence-tool-shape.mjs
	node tests/runtime/check-tool-response-capacity.mjs
	node tests/runtime/check-tool-capacity-compaction.mjs
	node tests/runtime/check-anthropic-tool-schema.mjs
	node tests/runtime/check-pi-upgrade-lifecycle.mjs

verify-contracts:
	$(NPM) run contracts:check
	$(CARGO) build --offline --locked -p data-agent --bin validate_contracts
	node tests/contracts/check-contracts.mjs

verify-runtime-flow:
	$(CARGO) build --offline --locked -p data-agent-api
	$(CARGO) build --offline --locked -p data-agent-worker
	$(NPM) run check:bridge
	node tests/runtime/check-runtime.mjs --flow

verify-recovery:
	$(CARGO) build --offline --locked -p data-agent-api
	$(CARGO) build --offline --locked -p data-agent-worker
	node tests/runtime/check-runtime.mjs --recovery
	node tests/mvp/check-worker-shutdown.mjs

verify-architecture:
	$(PYTHON) scripts/check_architecture.py
	$(PYTHON) -m unittest discover -s tests/architecture
	node tests/runtime/check-runtime.mjs --locking

verify-code:
	$(CARGO) fmt --all --check
	$(CARGO) clippy --offline --locked --all-targets -- -D warnings
	$(NPM) run check:types
	$(NPM) run build:web

.PHONY: verify-model-provider verify-model-trial verify-runtime-regression
verify-model-provider:
	$(CARGO) build --offline --locked -p data-agent-api -p data-agent-worker
	node tests/runtime/check-model-provider.mjs
	node tests/mvp/check-model-reservation-release.mjs
	node tests/runtime/check-model-admission.mjs

.PHONY: verify-runtime-capacity verify-retrieval-lease verify-worker-storage-recovery verify-compatible-restore
verify-runtime-capacity:
	$(CARGO) build --offline --locked -p data-agent-api
	$(CARGO) build --offline --locked -p data-agent-worker
	$(CARGO) test --offline --locked -p data-agent --lib modules::runtime::model_configuration::capacity
	node tests/runtime/check-capacity-derivation.mjs
	node tests/runtime/check-capacity-boundaries.mjs
	node tests/runtime/check-configured-provider.mjs
	node tests/runtime/check-sdk-event-order.mjs
	node tests/runtime/check-request-policy.mjs
	node tests/mvp/check-model-configuration.mjs
	node tests/mvp/check-configured-compaction.mjs

verify-retrieval-lease:
	$(CARGO) build --offline --locked -p data-agent-api -p data-agent-worker
	node tests/mvp/check-skill-selection-locks.mjs
	node tests/mvp/check-slow-retrieval-lease.mjs

verify-worker-storage-recovery:
	$(CARGO) build --offline --locked -p data-agent-api -p data-agent-worker
	node tests/runtime/check-harness-cleanup.mjs
	$(CARGO) test --offline --locked -p data-agent-worker
	$(CARGO) test --offline --locked -p data-agent --lib types::tests
	$(CARGO) test --offline --locked -p data-agent --lib use_cases::deliver_run::tests
	node tests/mvp/check-worker-storage-recovery.mjs
	node tests/mvp/check-worker-memory-progress.mjs
	node tests/mvp/check-worker-run-deadline.mjs

.PHONY: verify-upgrade-current verify-upgrade-frozen verify-upgrade-index
verify-upgrade-current:
	$(CARGO) build --offline --locked -p data-agent-api
	$(CARGO) build --offline --locked -p data-agent-worker
	$(PYTHON) -m unittest discover -s scripts -p 'test_development.py'
	node tests/runtime/check-harness-cleanup.mjs
	node tests/mvp/check-knowledge-read-pages.mjs
	node tests/mvp/check-source-upgrade.mjs --case current-owner
	node tests/mvp/check-source-upgrade.mjs --case public-retention
	node tests/mvp/check-source-upgrade.mjs --case public-retention --archive
	node tests/mvp/check-source-upgrade.mjs

verify-upgrade-frozen:
	$(CARGO) build --offline --locked -p data-agent-api
	$(CARGO) build --offline --locked -p data-agent-worker
	$(CARGO) test --offline --locked -p data-agent --lib use_cases::prefill_materials::tests
	node tests/mvp/check-frozen-job-inputs.mjs
	node tests/mvp/check-prefill-materials.mjs
	node tests/mvp/check-prefill-timeouts.mjs

verify-upgrade-index:
	$(CARGO) build --offline --locked -p data-agent-api
	$(CARGO) build --offline --locked -p data-agent-worker
	node tests/mvp/check-public-index-upgrade.mjs
	node tests/mvp/check-shared-index-todo.mjs
	node tests/mvp/check-index-concurrency.mjs

verify-compatible-restore:
	$(CARGO) build --offline --locked -p data-agent-api
	$(CARGO) build --offline --locked -p data-agent-worker
	node tests/mvp/check-native-compaction.mjs
	node tests/mvp/check-recovery-continuation.mjs
	node tests/mvp/check-sdk-upgrade-recovery.mjs
	node tests/mvp/check-large-tool-context.mjs
	node tests/mvp/check-session.mjs
	node tests/mvp/check-checkpoint-storage.mjs
	node tests/mvp/check-task-text-authority.mjs
	node tests/mvp/check-tool-contract-version.mjs
	node tests/mvp/check-evidence-tool-versions.mjs
	node tests/runtime/check-capacity-boundaries.mjs
	node tests/runtime/check-checkpoint-journal.mjs
	node tests/mvp/check-context-dependencies.mjs
	node tests/mvp/check-historical-source-access.mjs
	node tests/mvp/check-model-configuration.mjs
	node tests/mvp/check-memory-revisions.mjs
	node tests/mvp/check-task-answer-scope.mjs --upgrade
	node tests/mvp/check-task-answer-scope.mjs --upgrade --invalidate

# 只审计已完成的官方小样，不再次付费。执行获准小样须显式运行--run命令。
verify-model-trial:
	$(CARGO) build --offline --locked -p data-agent-api -p data-agent-worker
	node tests/runtime/run-deepseek-trial.mjs --audit

verify-runtime-regression: verify-runtime-flow verify-recovery verify-architecture

# 03语义整理三组验收：分段合同、整理运行链路、有效依赖语义。
.PHONY: verify-source-segments verify-source-preparation verify-effective-dependencies
verify-source-segments:
	$(CARGO) test --offline --locked -p data-agent --test source_segments

verify-source-preparation:
	$(CARGO) build --offline --locked -p data-agent-api -p data-agent-worker
	node tests/mvp/check-source-preparation.mjs
	node tests/mvp/check-source-preparation-concurrency.mjs
	node tests/mvp/check-document-preparation.mjs
	node tests/mvp/check-source-repreparation.mjs

verify-effective-dependencies:
	$(CARGO) test --offline --locked -p data-agent --test knowledge_dependencies
	node tests/mvp/check-context-dependencies.mjs
	node tests/mvp/check-retrieval-coverage.mjs

verify-task-conditions:
	$(CARGO) build --offline --locked -p data-agent-api
	$(CARGO) build --offline --locked -p data-agent-worker
	$(CARGO) build --offline --locked -p data-agent --bin validate_contracts
	$(CARGO) test --offline --locked -p data-agent --lib use_cases::query_semantics::tests
	$(CARGO) test --offline --locked -p data-agent --lib use_cases::historical_analysis::tests
	node tests/contracts/check-contracts.mjs
	node tests/mvp/check-tool-schema.mjs
	node tests/mvp/check-query-semantics.mjs
	node tests/mvp/check-task-text-authority.mjs
	node tests/mvp/check-source-limits.mjs
	node tests/mvp/check-source-search-admission.mjs
	node tests/mvp/check-source-search-admission.mjs source-selection
	node tests/mvp/check-time-roles.mjs

# 任务答案沿原route/finish交付；真实数据库脚本逐条执行。
.PHONY: verify-task-answers verify-task-answer-regression verify-task-answer-scope
verify-task-answers:
	$(CARGO) build --offline --locked -p data-agent-api
	$(CARGO) build --offline --locked -p data-agent-worker
	node tests/runtime/check-sdk-event-order.mjs
	node tests/runtime/check-checkpoint-journal.mjs
	node tests/runtime/check-answer-state.mjs
	node tests/mvp/check-tool-schema.mjs
	node tests/mvp/check-task-answers.mjs
	node tests/mvp/check-task-answers.mjs --failed-tool
	node tests/mvp/check-task-answers.mjs --write-task
	node tests/mvp/check-task-answer-recovery.mjs
	node tests/mvp/check-task-answer-boundaries.mjs
	node tests/mvp/check-task-query-answers.mjs
	node tests/mvp/check-task-query-answers.mjs --registered
	node tests/mvp/check-task-query-answers.mjs --committed
	node tests/mvp/check-task-query-answers.mjs --committed --older-query

verify-task-answer-regression:
	$(CARGO) build --offline --locked -p data-agent-api
	$(CARGO) build --offline --locked -p data-agent-worker
	node tests/mvp/check-final-answer.mjs
	node tests/mvp/check-grounded-answers.mjs
	node tests/mvp/check-answer-phase.mjs
	node tests/mvp/check-result-notification-answers.mjs
	node tests/mvp/check-mixed-task-cancellation.mjs
	node tests/mvp/check-mixed-task-pi-continuation.mjs
	node tests/mvp/check-mixed-task-bridge-cancellation.mjs
	node tests/mvp/check-conversation-timeline.mjs
	node tests/runtime/check-tool-capacity-compaction.mjs
	node tests/mvp/check-large-tool-context.mjs

verify-task-answer-scope:
	$(CARGO) build --offline --locked -p data-agent-api
	$(CARGO) build --offline --locked -p data-agent-worker
	node tests/mvp/check-task-answer-scope.mjs
	node tests/mvp/check-task-answer-scope.mjs --invalidate
	node tests/mvp/check-task-answer-scope.mjs --public-index
	node tests/mvp/check-task-answer-scope.mjs --cancel-b
	node tests/mvp/check-task-answer-scope.mjs --cancel-b --invalidate
	node tests/mvp/check-task-answer-scope.mjs --cancel-b-registered
	node tests/mvp/check-task-answer-scope.mjs --cancel-b-registered --invalidate
	node tests/mvp/check-task-answer-scope.mjs --cancel-b-unknown
	node tests/mvp/check-task-answer-scope.mjs --new-task=clarify
	node tests/mvp/check-task-answer-scope.mjs --new-task=clarify --null-task
	node tests/mvp/check-task-answer-scope.mjs --new-task=revise
	node tests/mvp/check-task-answer-scope.mjs --new-task=revise --null-task
	node tests/mvp/check-evidence-delivery.mjs
	node tests/mvp/check-evidence-assets.mjs
	node tests/mvp/check-evidence-response-budget.mjs
	node tests/mvp/check-evidence-tool-versions.mjs
	node tests/mvp/check-evidence-replay-boundaries.mjs
	node tests/mvp/check-historical-source-access.mjs
	node tests/mvp/check-task-text-authority.mjs

.PHONY: verify-task-scope verify-task-history
verify-task-scope:
	$(CARGO) build --offline --locked -p data-agent-api -p data-agent-worker
	node tests/mvp/check-source-limits.mjs
	node tests/mvp/check-source-limits-memory.mjs
	node tests/mvp/check-derived-source-dispatch.mjs
	node tests/mvp/check-legacy-source-limits.mjs
	node tests/mvp/check-task-projection.mjs
	node tests/mvp/check-task-projection.mjs --recover
	node tests/mvp/check-task-projection.mjs --recover-receipt
	node tests/mvp/check-request-context.mjs
	node tests/mvp/check-context-dependencies.mjs
	node tests/mvp/check-task-host-authority.mjs
	node tests/mvp/check-task-result-authority.mjs
	node tests/mvp/check-mixed-task-cancellation.mjs

# 04切片6–9历史分析验收：分用途读取、格式六投影与展示路径的过期局部化。
verify-task-history:
	$(CARGO) build --offline --locked -p data-agent-api -p data-agent-worker
	node tests/mvp/check-analysis-reports.mjs
	node tests/mvp/check-report-revision-continuation.mjs
	node tests/mvp/check-historical-source-access.mjs
	node tests/mvp/check-report-text-authority.mjs
	node tests/mvp/check-query-text-authority.mjs
	node tests/mvp/check-task-text-authority.mjs
	node tests/mvp/check-context-dependencies.mjs
	node tests/mvp/check-analysis-reports-browser.mjs

.PHONY: verify-query-workflow verify-knowledge-workflow verify-mvp-browser verify-mvp-regression
verify-query-workflow:
	$(CARGO) build --offline --locked -p data-agent-api -p data-agent-worker
	node tests/runtime/check-synthetic-knowledge-reading.mjs
	node tests/mvp/check-query-workflow.mjs
	node tests/mvp/check-query-grain-protocol.mjs
	node tests/mvp/check-query-boundaries.mjs
	node tests/mvp/check-request-clock.mjs
	node tests/mvp/check-workflow-reliability.mjs
	node tests/mvp/check-answer-phase.mjs

verify-knowledge-workflow:
	$(CARGO) build --offline --locked -p data-agent-api -p data-agent-worker
	$(CARGO) test --offline --locked -p data-agent --lib modules::ingestion::prefill::tests
	$(CARGO) test --offline --locked -p data-agent --lib modules::assets::tests
	$(CARGO) test --offline --locked -p data-agent --lib modules::retrieval::semantic_context_tests
	node tests/mvp/check-knowledge-workflow.mjs
	node tests/mvp/check-table-catalog-access.mjs
	node tests/mvp/check-boundaries.mjs
	node tests/mvp/check-lifecycle.mjs
	node tests/mvp/check-mixed-task-cancellation.mjs
	node tests/mvp/check-mixed-task-pi-continuation.mjs
	node tests/mvp/check-mixed-task-bridge-cancellation.mjs
	node tests/mvp/check-authority.mjs
	node tests/mvp/check-context-dependencies.mjs
	node tests/mvp/check-long-conversation.mjs
	node tests/mvp/check-asset-directory.mjs
	node tests/mvp/check-prefill.mjs
	node tests/mvp/check-prefill-materials.mjs
	node tests/mvp/check-prefill-concurrency.mjs
	node tests/mvp/check-prefill-timeouts.mjs
	node tests/mvp/check-source-preparation.mjs
	node tests/mvp/check-source-preparation-concurrency.mjs
	node tests/mvp/check-document-preparation.mjs
	node tests/mvp/check-maintenance-replay.mjs
	node tests/mvp/check-memory-revisions.mjs
	node tests/mvp/check-completion-gaps.mjs
	node tests/mvp/check-retrieval-coverage.mjs
	node tests/mvp/check-index-concurrency.mjs
	node tests/mvp/check-catalog-import.mjs
	node tests/mvp/check-analysis-preference.mjs

verify-mvp-browser:
	$(CARGO) build --offline --locked -p data-agent-api -p data-agent-worker
	node tests/mvp/check-browser.mjs
	node tests/mvp/check-conversation-timeline.mjs
	node tests/mvp/check-history-browser.mjs
	node tests/mvp/check-live-workbench.mjs
	node tests/mvp/check-live-projection-isolation.mjs

.PHONY: verify-management-buttons verify-memory-runtime
verify-management-buttons:
	$(CARGO) build --offline --locked -p data-agent-api -p data-agent-worker
	node tests/mvp/check-batch-edit-retry.mjs
	node tests/mvp/check-management-buttons.mjs
	node tests/mvp/check-related-knowledge-browser.mjs

verify-memory-runtime: verify-code verify-contracts verify-architecture verify-runtime-flow verify-recovery verify-model-provider
	$(PYTHON) -m unittest discover -s scripts -p 'test_development.py'
	node tests/mvp/check-session.mjs
	node tests/mvp/check-native-compaction.mjs
	node tests/mvp/check-recovery-continuation.mjs

.PHONY: verify-business-acceptance
verify-business-acceptance:
	$(CARGO) build --offline --locked -p data-agent-api -p data-agent-worker
	node tests/mvp/check-business-evaluator.mjs
	node tests/mvp/run-business-acceptance.mjs --check

verify-mvp-regression: verify-code verify-model-provider verify-runtime-regression verify-materials verify-fixture
	$(CARGO) test --offline --locked -p data-agent --lib modules::runtime::outputs::tests
	node tests/mvp/check-session.mjs
	node tests/mvp/check-checkpoint-storage.mjs
	node tests/mvp/check-data-provider.mjs
	node tests/mvp/check-native-compaction.mjs
	node tests/mvp/check-large-tool-context.mjs
	node tests/mvp/check-recovery-continuation.mjs
	node tests/mvp/check-worker-run-deadline.mjs
	node tests/mvp/run-deepseek-workflow.mjs --check

.PHONY: verify-hybrid-retrieval
verify-hybrid-retrieval:
	$(CARGO) build --offline --locked -p data-agent-api
	$(CARGO) build --offline --locked -p data-agent-worker
	node tests/mvp/check-hybrid-retrieval.mjs

# 检索范围、排名、故障回执与迁接续接；完整验收范围和剩余缺口见CURRENT。
.PHONY: verify-hybrid-scope
verify-hybrid-scope:
	$(CARGO) build --offline --locked -p data-agent-api
	$(CARGO) build --offline --locked -p data-agent-worker
	$(CARGO) test --offline --locked -p data-agent --lib modules::retrieval
	node tests/mvp/check-retrieval-allowed-set.mjs
	node tests/mvp/check-retrieval-ranking.mjs
	node tests/mvp/check-retrieval-excerpts.mjs
	node tests/mvp/check-retrieval-entry-read.mjs
	node tests/mvp/check-retrieval-content-units.mjs
	node tests/mvp/check-retrieval-progress.mjs
	node tests/mvp/check-retrieval-scope.mjs
	node tests/mvp/check-context-dependencies.mjs
	node tests/mvp/check-structure-column-bindings.mjs
	node tests/mvp/check-retrieval-deep-advance.mjs
	node tests/mvp/check-retrieval-deadline-order.mjs
	node tests/mvp/check-retrieval-granularity.mjs
	node tests/mvp/check-retrieval-channel-coverage.mjs
	node tests/mvp/check-retrieval-channel-faults.mjs
	node tests/mvp/check-search-continuation-lifetime.mjs
	node tests/mvp/check-source-recall.mjs
	node tests/mvp/check-shared-index-todo.mjs

# 合同2受控验收：真实存储、专用索引与本地协议端点；数据库脚本串行执行。
.PHONY: verify-evidence-delivery verify-evidence-search verify-evidence-assets verify-evidence-recovery
verify-evidence-delivery:
	$(CARGO) build --offline --locked -p data-agent-api
	$(CARGO) build --offline --locked -p data-agent-worker
	$(CARGO) test --offline --locked -p data-agent --test knowledge_dependencies source_supports_register_required_dependencies_on_the_effective_human_layer
	node tests/mvp/check-support-completeness.mjs
	node tests/mvp/check-knowledge-read-pages.mjs
	node tests/mvp/check-evidence-delivery.mjs
	node tests/mvp/check-evidence-source.mjs
	node tests/mvp/check-evidence-knowledge.mjs
	node tests/mvp/check-evidence-statements.mjs
	node tests/mvp/check-evidence-read-boundaries.mjs
	node tests/mvp/check-evidence-support-lease.mjs
	node tests/mvp/check-evidence-supports.mjs
	node tests/mvp/check-evidence-support-references.mjs
	node tests/mvp/check-evidence-support-continuation.mjs
	node tests/mvp/check-evidence-read-capacity.mjs

verify-evidence-search:
	$(CARGO) build --offline --locked -p data-agent-api
	$(CARGO) build --offline --locked -p data-agent-worker
	$(CARGO) test --offline --locked -p data-agent --test search_continuation
	node tests/mvp/check-evidence-search.mjs
	node tests/mvp/check-evidence-search-continuation.mjs
	node tests/mvp/check-evidence-cursor-boundaries.mjs
	node tests/mvp/check-source-selection-cursors.mjs
	node tests/mvp/check-evidence-search-progress.mjs
	node tests/mvp/check-evidence-search-hints.mjs
	node tests/mvp/check-evidence-search-hint-boundaries.mjs raw
	node tests/mvp/check-evidence-search-hint-boundaries.mjs exact
	node tests/mvp/check-evidence-search-assets.mjs
	node tests/mvp/check-evidence-search-capacity.mjs
	node tests/mvp/check-evidence-search-compact-capacity.mjs
	node tests/mvp/check-evidence-search-compact-capacity.mjs sql-unconfigured
	node tests/mvp/check-evidence-search-compact-capacity.mjs sql-fallback
	node tests/mvp/check-evidence-search-statements.mjs
	node tests/mvp/check-retrieval-coverage.mjs

verify-evidence-assets:
	node tests/mvp/check-asset-directory.mjs
	node tests/mvp/check-evidence-assets.mjs
	node tests/mvp/check-memory-revisions.mjs
	node tests/mvp/check-completion-gaps.mjs

verify-evidence-recovery:
	node tests/runtime/check-pi-sdk.mjs
	node tests/runtime/check-answer-state.mjs
	node tests/runtime/check-request-policy.mjs
	node tests/mvp/check-evidence-tool-versions.mjs
	node tests/mvp/check-evidence-response-budget.mjs
	node tests/mvp/check-evidence-replay-boundaries.mjs
	node tests/mvp/check-large-tool-context.mjs
	node tests/mvp/check-native-compaction.mjs
	node tests/mvp/check-recovery-continuation.mjs
	node tests/mvp/check-authority.mjs

.PHONY: verify-catalog-workflow
verify-catalog-workflow:
	$(CARGO) build --offline --locked -p data-agent-api -p data-agent-worker
	node tests/mvp/check-catalog-import.mjs
	node tests/mvp/check-analysis-preference.mjs
	node tests/mvp/check-retrieval-coverage.mjs

.PHONY: verify-source-content verify-source-sync verify-source-upgrade verify-source-ui
verify-source-content:
	$(CARGO) build --offline --locked -p data-agent-api -p data-agent-worker
	$(CARGO) test --offline --locked -p data-agent --lib modules::ingestion::catalog_content
	$(CARGO) test --offline --locked -p data-agent --lib types::source_locator
	node tests/runtime/check-catalog-transport.mjs
	node tests/mvp/check-source-content.mjs
	node tests/mvp/check-source-storage.mjs --case representation
	node tests/mvp/check-source-storage.mjs --case boundary

verify-source-sync:
	$(CARGO) build --offline --locked -p data-agent-api -p data-agent-worker
	node tests/mvp/check-source-sync.mjs
	node tests/mvp/check-source-sync-recovery.mjs
	node tests/mvp/check-source-sync-heartbeat.mjs
	node tests/mvp/check-source-storage.mjs --case pages
	node tests/mvp/check-catalog-import.mjs
	node tests/mvp/check-maintenance-replay.mjs
	node tests/mvp/check-prefill-concurrency.mjs
	node tests/mvp/check-semantic-role-boundaries.mjs --case sync

verify-source-upgrade:
	$(CARGO) build --offline --locked -p data-agent-api -p data-agent-worker
	node tests/mvp/check-source-upgrade.mjs

verify-source-ui:
	$(CARGO) build --offline --locked -p data-agent-api -p data-agent-worker
	node tests/runtime/check-source-sync-browser.mjs
	node tests/mvp/check-source-sync-browser.mjs

.PHONY: verify-official-business
verify-official-business:
	node tests/mvp/check-official-business-evidence.mjs

.PHONY: setup-memory verify-memory
setup-memory:
	uv venv --python 3.12 .local/memory-venv
	uv pip sync --python .local/memory-venv/bin/python --require-hashes apps/memory/requirements.lock

verify-memory:
	$(CARGO) build --offline --locked -p data-agent-api -p data-agent-worker
	.local/memory-venv/bin/python -m unittest discover -s tests/memory -p 'test_*.py'
	node tests/mvp/check-memory-provider.mjs

.PHONY: verify-memory-scope verify-message-markdown verify-closeout-session
verify-memory-scope:
	$(CARGO) test --offline --locked -p data-agent --lib modules::assets::tests
	node tests/mvp/check-memory-revisions.mjs

verify-message-markdown:
	node tests/mvp/check-message-markdown.mjs

verify-closeout-session:
	node tests/mvp/check-session.mjs
	node tests/mvp/check-native-compaction.mjs

.PHONY: verify-shared-embedding
verify-shared-embedding:
	$(CARGO) build --offline --locked -p data-agent-api -p data-agent-worker
	$(CARGO) test --offline --locked -p data-agent --lib modules::retrieval::embedding::tests
	$(PYTHON) -m unittest discover -s scripts -p 'test_development.py'
	node tests/mvp/check-shared-embedding.mjs

.PHONY: verify-semantic-governance
verify-semantic-governance:
	$(CARGO) build --offline --locked -p data-agent-api -p data-agent-worker
	node tests/mvp/check-semantic-governance.mjs --case GOV01
	node tests/mvp/check-semantic-governance.mjs --case GOV02
	node tests/mvp/check-semantic-governance.mjs --case GOV03
	node tests/mvp/check-semantic-governance.mjs --case GOV04
	node tests/mvp/check-semantic-governance.mjs --case GOV05
	node tests/mvp/check-creator-ownership.mjs
	node tests/mvp/check-semantic-role-boundaries.mjs --case sync
	node tests/mvp/check-semantic-role-boundaries.mjs --case members
	node tests/mvp/check-semantic-role-boundaries.mjs --case directory
	node tests/mvp/check-semantic-governance-browser.mjs
	node tests/mvp/check-creator-ownership-browser.mjs
	node tests/mvp/check-semantic-role-boundaries-browser.mjs

.PHONY: verify-cockpit
verify-cockpit:
	$(CARGO) build --offline --locked -p data-agent-api -p data-agent-worker
	$(PYTHON) docs/sources/cockpit/verify.py
	$(PYTHON) docs/dogfood/cockpit/verify.py
	node tests/mvp/check-cockpit-source.mjs --v2
