.PHONY: setup-node setup-rust verify verify-materials verify-delivery verify-increment verify-fixture verify-node verify-rust verify-browser verify-infra infra-up infra-down infra-status vm-stop prototype

PYTHON ?= python3
NPM ?= npm
CARGO ?= $(HOME)/.cargo/bin/cargo

setup-node:
	$(NPM) ci --engine-strict --no-audit --no-fund
	$(NPM) run browser:install

setup-rust:
	$(CARGO) fetch --locked
	$(PYTHON) scripts/setup_embedding.py

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

verify-contracts:
	$(NPM) run contracts:check
	$(CARGO) build --offline --locked -p data-agent --bin validate_contracts
	node tests/contracts/check-contracts.mjs

verify-runtime-flow:
	$(CARGO) build --offline --locked -p data-agent-api -p data-agent-worker
	$(NPM) run check:bridge
	node tests/runtime/check-runtime.mjs --flow

verify-recovery:
	$(CARGO) build --offline --locked -p data-agent-api -p data-agent-worker
	node tests/runtime/check-runtime.mjs --recovery

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
	node tests/runtime/check-model-admission.mjs

# 只审计已完成的官方小样，不再次付费。执行获准小样须显式运行--run命令。
verify-model-trial:
	$(CARGO) build --offline --locked -p data-agent-api -p data-agent-worker
	node tests/runtime/run-deepseek-trial.mjs --audit

verify-runtime-regression: verify-runtime-flow verify-recovery verify-architecture

.PHONY: verify-query-workflow verify-knowledge-workflow verify-mvp-browser verify-mvp-regression
verify-query-workflow:
	$(CARGO) build --offline --locked -p data-agent-api -p data-agent-worker
	node tests/mvp/check-query-workflow.mjs
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

.PHONY: verify-management-buttons verify-memory-runtime
verify-management-buttons:
	$(CARGO) build --offline --locked -p data-agent-api -p data-agent-worker
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
	$(CARGO) build --offline --locked -p data-agent-api -p data-agent-worker
	node tests/mvp/check-hybrid-retrieval.mjs

.PHONY: verify-catalog-workflow
verify-catalog-workflow:
	$(CARGO) build --offline --locked -p data-agent-api -p data-agent-worker
	node tests/mvp/check-catalog-import.mjs
	node tests/mvp/check-analysis-preference.mjs
	node tests/mvp/check-retrieval-coverage.mjs

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
