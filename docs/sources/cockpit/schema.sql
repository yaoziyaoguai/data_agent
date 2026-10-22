-- 完全合成的座舱语音交互日志；无音频、VIN、真实位置或公司信息。

PRAGMA foreign_keys = ON;

-- 合成座舱设备型号：一个虚构座舱设备规格。
CREATE TABLE syn_vehicle_model (
  model_id TEXT NOT NULL,
  model_name TEXT NOT NULL,
  hardware_family TEXT NOT NULL,
  microphone_zone_count INTEGER NOT NULL CHECK (microphone_zone_count >= 0),
  speaker_zone_count INTEGER NOT NULL CHECK (speaker_zone_count >= 0),
  memory_capacity_mib INTEGER NOT NULL CHECK (memory_capacity_mib >= 1),
  edge_compute_tier TEXT NOT NULL CHECK (edge_compute_tier IN ('basic', 'standard', 'extended')),
  supports_barge_in INTEGER NOT NULL CHECK (supports_barge_in IN (0, 1)),
  supports_offline_asr INTEGER NOT NULL CHECK (supports_offline_asr IN (0, 1)),
  supported_locales TEXT NOT NULL,
  introduced_date TEXT NOT NULL,
  is_simulated INTEGER NOT NULL CHECK (is_simulated IN (0, 1)),
  PRIMARY KEY (model_id),
  CHECK (is_simulated=1)
);

-- 合成软件构建：一个语音运行环境的软件构建。
CREATE TABLE syn_software_build (
  build_id TEXT NOT NULL,
  build_label TEXT NOT NULL,
  released_at TEXT NOT NULL,
  base_build_id TEXT,
  release_track TEXT NOT NULL CHECK (release_track IN ('lab', 'trial')),
  protocol_revision INTEGER NOT NULL CHECK (protocol_revision >= 1),
  dialogue_engine_revision INTEGER NOT NULL CHECK (dialogue_engine_revision >= 1),
  routing_revision INTEGER NOT NULL CHECK (routing_revision >= 1),
  default_locale TEXT NOT NULL CHECK (default_locale IN ('zh-CN', 'en-US')),
  allows_cloud_fallback INTEGER NOT NULL CHECK (allows_cloud_fallback IN (0, 1)),
  is_withdrawn INTEGER NOT NULL CHECK (is_withdrawn IN (0, 1)),
  withdrawn_at TEXT,
  PRIMARY KEY (build_id),
  CHECK ((is_withdrawn=0 AND withdrawn_at IS NULL) OR (is_withdrawn=1 AND withdrawn_at IS NOT NULL)),
  FOREIGN KEY (base_build_id) REFERENCES syn_software_build(build_id)
);

CREATE INDEX ix_syn_software_build_base_build_id ON syn_software_build(base_build_id);

-- 合成语音设备：一辆无真实身份信息的合成车辆。
CREATE TABLE syn_vehicle (
  vehicle_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  fleet_group TEXT NOT NULL CHECK (fleet_group IN ('group_a', 'group_b', 'group_c')),
  region_code TEXT NOT NULL CHECK (region_code IN ('zone_n', 'zone_s', 'zone_e', 'zone_w')),
  enrolled_at TEXT NOT NULL,
  first_activated_at TEXT NOT NULL,
  current_build_id TEXT NOT NULL,
  telemetry_consent INTEGER NOT NULL CHECK (telemetry_consent IN (0, 1)),
  is_lab_unit INTEGER NOT NULL CHECK (is_lab_unit IN (0, 1)),
  business_timezone TEXT NOT NULL CHECK (business_timezone IN ('UTC')),
  default_locale TEXT NOT NULL CHECK (default_locale IN ('zh-CN', 'en-US')),
  retired_at TEXT,
  identity_policy TEXT NOT NULL CHECK (identity_policy IN ('synthetic_only')),
  PRIMARY KEY (vehicle_id),
  CHECK (first_activated_at >= enrolled_at),
  CHECK (retired_at IS NULL OR retired_at > first_activated_at),
  FOREIGN KEY (model_id) REFERENCES syn_vehicle_model(model_id),
  FOREIGN KEY (current_build_id) REFERENCES syn_software_build(build_id)
);

CREATE INDEX ix_syn_vehicle_model_id ON syn_vehicle(model_id);

CREATE INDEX ix_syn_vehicle_current_build_id ON syn_vehicle(current_build_id);

-- 语音能力组：一个通用座舱语音能力组。
CREATE TABLE syn_voice_capability (
  capability_id TEXT NOT NULL,
  capability_name TEXT NOT NULL,
  domain_code TEXT NOT NULL CHECK (domain_code IN ('climate', 'media', 'navigation', 'vehicle_status', 'system_settings', 'assistant_help', 'communication')),
  execution_kind TEXT NOT NULL CHECK (execution_kind IN ('local_action', 'read_only', 'simulated_remote')),
  requires_network INTEGER NOT NULL CHECK (requires_network IN (0, 1)),
  supports_context INTEGER NOT NULL CHECK (supports_context IN (0, 1)),
  supports_cancel INTEGER NOT NULL CHECK (supports_cancel IN (0, 1)),
  supports_clarification INTEGER NOT NULL CHECK (supports_clarification IN (0, 1)),
  latency_budget_ms INTEGER NOT NULL CHECK (latency_budget_ms >= 0),
  seat_scope TEXT NOT NULL CHECK (seat_scope IN ('driver', 'front', 'all')),
  capability_state TEXT NOT NULL CHECK (capability_state IN ('active', 'deprecated')),
  scope_note TEXT NOT NULL,
  PRIMARY KEY (capability_id)
);

-- 意图与必填槽位：一个语音意图定义。
CREATE TABLE syn_intent_catalog (
  intent_id TEXT NOT NULL,
  capability_id TEXT NOT NULL,
  intent_name TEXT NOT NULL,
  action_name TEXT NOT NULL,
  required_slot_names TEXT NOT NULL,
  optional_slot_names TEXT NOT NULL,
  slot_validation_rule TEXT NOT NULL,
  may_use_context INTEGER NOT NULL CHECK (may_use_context IN (0, 1)),
  requires_effect_receipt INTEGER NOT NULL CHECK (requires_effect_receipt IN (0, 1)),
  confirmation_mode TEXT NOT NULL CHECK (confirmation_mode IN ('none', 'clarify_missing')),
  intent_state TEXT NOT NULL CHECK (intent_state IN ('active', 'deprecated')),
  example_command TEXT NOT NULL,
  PRIMARY KEY (intent_id),
  FOREIGN KEY (capability_id) REFERENCES syn_voice_capability(capability_id)
);

CREATE INDEX ix_syn_intent_catalog_capability_id ON syn_intent_catalog(capability_id);

-- 识别与理解模型：一个合成ASR或NLU模型配置。
CREATE TABLE syn_recognizer_model (
  recognizer_id TEXT NOT NULL,
  recognizer_name TEXT NOT NULL,
  component TEXT NOT NULL CHECK (component IN ('asr', 'nlu')),
  endpoint_kind TEXT NOT NULL CHECK (endpoint_kind IN ('edge', 'cloud')),
  model_revision TEXT NOT NULL,
  locale TEXT NOT NULL CHECK (locale IN ('zh-CN', 'en-US')),
  available_from TEXT NOT NULL,
  available_until TEXT,
  timeout_ms INTEGER NOT NULL CHECK (timeout_ms >= 0),
  supports_streaming INTEGER NOT NULL CHECK (supports_streaming IN (0, 1)),
  supports_context_bias INTEGER NOT NULL CHECK (supports_context_bias IN (0, 1)),
  training_origin TEXT NOT NULL CHECK (training_origin IN ('synthetic_profile_only')),
  PRIMARY KEY (recognizer_id)
);

-- 交互运行策略：一个在会话中冻结的运行策略。
CREATE TABLE syn_runtime_policy (
  policy_id TEXT NOT NULL,
  policy_name TEXT NOT NULL,
  valid_from TEXT NOT NULL,
  valid_until TEXT,
  endpoint_preference TEXT NOT NULL CHECK (endpoint_preference IN ('edge_only', 'cloud_preferred', 'adaptive')),
  asr_max_attempts INTEGER NOT NULL CHECK (asr_max_attempts >= 1) CHECK (asr_max_attempts <= 3),
  nlu_max_attempts INTEGER NOT NULL CHECK (nlu_max_attempts >= 1) CHECK (nlu_max_attempts <= 3),
  action_max_attempts INTEGER NOT NULL CHECK (action_max_attempts >= 1) CHECK (action_max_attempts <= 3),
  clarification_max_turns INTEGER NOT NULL CHECK (clarification_max_turns >= 1) CHECK (clarification_max_turns <= 4),
  turn_timeout_ms INTEGER NOT NULL CHECK (turn_timeout_ms >= 0),
  allow_barge_in INTEGER NOT NULL CHECK (allow_barge_in IN (0, 1)),
  allow_context_carry INTEGER NOT NULL CHECK (allow_context_carry IN (0, 1)),
  late_response_policy TEXT NOT NULL CHECK (late_response_policy IN ('discard', 'accept_if_pending')),
  cloud_rtt_threshold_ms INTEGER NOT NULL CHECK (cloud_rtt_threshold_ms >= 0),
  fallback_policy TEXT NOT NULL CHECK (fallback_policy IN ('edge_fallback', 'none')),
  deduplicate_actions INTEGER NOT NULL CHECK (deduplicate_actions IN (0, 1)),
  PRIMARY KEY (policy_id)
);

-- 语音交互会话：一次连续的多轮座舱语音会话。
CREATE TABLE syn_voice_session (
  session_id TEXT NOT NULL,
  vehicle_id TEXT NOT NULL,
  build_id TEXT NOT NULL,
  policy_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
  entry_kind TEXT NOT NULL CHECK (entry_kind IN ('wake_word', 'button', 'continuous')),
  locale TEXT NOT NULL CHECK (locale IN ('zh-CN', 'en-US')),
  seat_zone TEXT NOT NULL CHECK (seat_zone IN ('driver', 'front_passenger', 'rear')),
  motion_state TEXT NOT NULL CHECK (motion_state IN ('parked', 'moving')),
  network_at_start TEXT NOT NULL CHECK (network_at_start IN ('online', 'offline')),
  end_reason TEXT NOT NULL CHECK (end_reason IN ('idle', 'user_cancel', 'session_timeout', 'system_end')),
  is_complete INTEGER NOT NULL CHECK (is_complete IN (0, 1)),
  received_at TEXT NOT NULL,
  quality_state TEXT NOT NULL CHECK (quality_state IN ('valid', 'invalid')),
  PRIMARY KEY (session_id),
  CHECK (ended_at > started_at),
  FOREIGN KEY (vehicle_id) REFERENCES syn_vehicle(vehicle_id),
  FOREIGN KEY (build_id) REFERENCES syn_software_build(build_id),
  FOREIGN KEY (policy_id) REFERENCES syn_runtime_policy(policy_id)
);

CREATE INDEX ix_syn_voice_session_vehicle_id ON syn_voice_session(vehicle_id);

CREATE INDEX ix_syn_voice_session_build_id ON syn_voice_session(build_id);

CREATE INDEX ix_syn_voice_session_policy_id ON syn_voice_session(policy_id);

-- 语音入口触发尝试：一次唤醒或按键入口触发观测。
CREATE TABLE syn_wakeup_attempt (
  wakeup_id TEXT NOT NULL,
  vehicle_id TEXT NOT NULL,
  build_id TEXT NOT NULL,
  session_id TEXT,
  started_at TEXT NOT NULL,
  trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('wake_word', 'button', 'continuous')),
  seat_zone TEXT NOT NULL CHECK (seat_zone IN ('driver', 'front_passenger', 'rear')),
  candidate_detected INTEGER NOT NULL CHECK (candidate_detected IN (0, 1)),
  accepted INTEGER NOT NULL CHECK (accepted IN (0, 1)),
  reject_reason TEXT NOT NULL CHECK (reject_reason IN ('none', 'not_detected', 'false_trigger', 'debounce', 'policy')),
  confidence_permille INTEGER CHECK (confidence_permille >= 0) CHECK (confidence_permille <= 1000),
  reference_is_intended INTEGER CHECK (reference_is_intended IN (0, 1)),
  label_origin TEXT NOT NULL CHECK (label_origin IN ('synthetic_authored', 'none')),
  decision_ms INTEGER NOT NULL CHECK (decision_ms >= 0),
  received_at TEXT NOT NULL,
  quality_state TEXT NOT NULL CHECK (quality_state IN ('valid', 'invalid')),
  PRIMARY KEY (wakeup_id),
  CHECK ((accepted=1 AND candidate_detected=1 AND session_id IS NOT NULL AND reject_reason='none') OR (accepted=0 AND session_id IS NULL AND reject_reason<>'none')),
  FOREIGN KEY (vehicle_id) REFERENCES syn_vehicle(vehicle_id),
  FOREIGN KEY (build_id) REFERENCES syn_software_build(build_id),
  FOREIGN KEY (session_id) REFERENCES syn_voice_session(session_id)
);

CREATE INDEX ix_syn_wakeup_attempt_vehicle_id ON syn_wakeup_attempt(vehicle_id);

CREATE INDEX ix_syn_wakeup_attempt_build_id ON syn_wakeup_attempt(build_id);

CREATE INDEX ix_syn_wakeup_attempt_session_id ON syn_wakeup_attempt(session_id);

-- 用户交互轮次：同会话的一条用户输入及任务终态记录。
CREATE TABLE syn_voice_turn (
  turn_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  turn_no INTEGER NOT NULL CHECK (turn_no >= 1),
  parent_turn_id TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  input_kind TEXT NOT NULL CHECK (input_kind IN ('command', 'follow_up', 'cancel', 'silence')),
  reference_text TEXT,
  reference_intent_id TEXT,
  label_origin TEXT NOT NULL CHECK (label_origin IN ('synthetic_authored', 'none')),
  locale TEXT NOT NULL CHECK (locale IN ('zh-CN', 'en-US')),
  seat_zone TEXT NOT NULL CHECK (seat_zone IN ('driver', 'front_passenger', 'rear')),
  input_ms INTEGER NOT NULL CHECK (input_ms >= 0),
  terminal_offset_ms INTEGER NOT NULL CHECK (terminal_offset_ms >= 0),
  task_latency_ms INTEGER NOT NULL CHECK (task_latency_ms >= 0),
  first_audio_latency_ms INTEGER CHECK (first_audio_latency_ms >= 0),
  final_outcome TEXT NOT NULL CHECK (final_outcome IN ('completed', 'clarification_pending', 'rejected', 'cancelled', 'no_speech', 'failed', 'unknown')),
  final_response_text TEXT,
  received_at TEXT NOT NULL,
  quality_state TEXT NOT NULL CHECK (quality_state IN ('valid', 'invalid')),
  PRIMARY KEY (turn_id),
  UNIQUE (session_id, turn_no),
  CHECK (finished_at >= started_at),
  CHECK (terminal_offset_ms >= input_ms),
  CHECK (task_latency_ms = terminal_offset_ms - input_ms),
  FOREIGN KEY (session_id) REFERENCES syn_voice_session(session_id),
  FOREIGN KEY (parent_turn_id) REFERENCES syn_voice_turn(turn_id),
  FOREIGN KEY (reference_intent_id) REFERENCES syn_intent_catalog(intent_id)
);

CREATE INDEX ix_syn_voice_turn_session_id ON syn_voice_turn(session_id);

CREATE INDEX ix_syn_voice_turn_parent_turn_id ON syn_voice_turn(parent_turn_id);

CREATE INDEX ix_syn_voice_turn_reference_intent_id ON syn_voice_turn(reference_intent_id);

-- 前端VAD分段：一轮输入中的一个模拟语音/静音/噪声片段。
CREATE TABLE syn_frontend_segment (
  segment_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  segment_no INTEGER NOT NULL CHECK (segment_no >= 1),
  segment_kind TEXT NOT NULL CHECK (segment_kind IN ('speech', 'silence', 'noise')),
  start_offset_ms INTEGER NOT NULL CHECK (start_offset_ms >= 0),
  end_offset_ms INTEGER NOT NULL CHECK (end_offset_ms >= 0),
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
  speech_detected INTEGER NOT NULL CHECK (speech_detected IN (0, 1)),
  endpoint_reason TEXT NOT NULL CHECK (endpoint_reason IN ('speech_end', 'silence_threshold', 'input_end', 'manual_stop')),
  clipped_ms INTEGER NOT NULL CHECK (clipped_ms >= 0),
  feature_frame_count INTEGER NOT NULL CHECK (feature_frame_count >= 0),
  noise_bucket TEXT NOT NULL CHECK (noise_bucket IN ('quiet', 'moderate', 'noisy')),
  received_at TEXT NOT NULL,
  quality_state TEXT NOT NULL CHECK (quality_state IN ('valid', 'invalid')),
  PRIMARY KEY (segment_id),
  UNIQUE (turn_id, segment_no),
  CHECK (end_offset_ms > start_offset_ms),
  CHECK (duration_ms=end_offset_ms-start_offset_ms),
  CHECK (clipped_ms <= duration_ms),
  FOREIGN KEY (turn_id) REFERENCES syn_voice_turn(turn_id)
);

CREATE INDEX ix_syn_frontend_segment_turn_id ON syn_frontend_segment(turn_id);

-- ASR处理尝试：一轮输入的一次端侧或云侧识别尝试。
CREATE TABLE syn_asr_attempt (
  asr_attempt_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  attempt_no INTEGER NOT NULL CHECK (attempt_no >= 1),
  recognizer_id TEXT NOT NULL,
  endpoint_kind TEXT NOT NULL CHECK (endpoint_kind IN ('edge', 'cloud')),
  start_offset_ms INTEGER NOT NULL CHECK (start_offset_ms >= 0),
  finish_offset_ms INTEGER NOT NULL CHECK (finish_offset_ms >= 0),
  wall_ms INTEGER NOT NULL CHECK (wall_ms >= 0),
  queued_ms INTEGER NOT NULL CHECK (queued_ms >= 0),
  outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed', 'timeout', 'cancelled')),
  fallback_reason TEXT NOT NULL CHECK (fallback_reason IN ('none', 'cloud_timeout', 'network_unavailable', 'model_failure')),
  timeout_ms INTEGER NOT NULL CHECK (timeout_ms >= 0),
  is_streaming INTEGER NOT NULL CHECK (is_streaming IN (0, 1)),
  partial_result_count INTEGER NOT NULL CHECK (partial_result_count >= 0),
  error_code TEXT,
  received_at TEXT NOT NULL,
  PRIMARY KEY (asr_attempt_id),
  UNIQUE (turn_id, attempt_no),
  CHECK (finish_offset_ms >= start_offset_ms),
  CHECK (wall_ms=finish_offset_ms-start_offset_ms),
  CHECK (queued_ms<=wall_ms),
  FOREIGN KEY (turn_id) REFERENCES syn_voice_turn(turn_id),
  FOREIGN KEY (recognizer_id) REFERENCES syn_recognizer_model(recognizer_id)
);

CREATE INDEX ix_syn_asr_attempt_turn_id ON syn_asr_attempt(turn_id);

CREATE INDEX ix_syn_asr_attempt_recognizer_id ON syn_asr_attempt(recognizer_id);

-- ASR候选及最终选择：一次成功ASR尝试的一条候选转写。
CREATE TABLE syn_asr_hypothesis (
  hypothesis_id TEXT NOT NULL,
  asr_attempt_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  candidate_rank INTEGER NOT NULL CHECK (candidate_rank >= 1),
  hypothesis_text TEXT NOT NULL,
  normalized_text TEXT NOT NULL,
  confidence_permille INTEGER NOT NULL CHECK (confidence_permille >= 0) CHECK (confidence_permille <= 1000),
  is_final INTEGER NOT NULL CHECK (is_final IN (0, 1)),
  selected_for_nlu INTEGER NOT NULL CHECK (selected_for_nlu IN (0, 1)),
  selection_reason TEXT NOT NULL CHECK (selection_reason IN ('rank', 'context_bias', 'fallback', 'not_selected')),
  locale TEXT NOT NULL CHECK (locale IN ('zh-CN', 'en-US')),
  received_at TEXT NOT NULL,
  PRIMARY KEY (hypothesis_id),
  UNIQUE (asr_attempt_id, candidate_rank),
  FOREIGN KEY (asr_attempt_id) REFERENCES syn_asr_attempt(asr_attempt_id),
  FOREIGN KEY (turn_id) REFERENCES syn_voice_turn(turn_id)
);

CREATE INDEX ix_syn_asr_hypothesis_asr_attempt_id ON syn_asr_hypothesis(asr_attempt_id);

CREATE INDEX ix_syn_asr_hypothesis_turn_id ON syn_asr_hypothesis(turn_id);

-- 意图理解尝试：一轮的一次意图/槽位解析。
CREATE TABLE syn_nlu_attempt (
  nlu_attempt_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  hypothesis_id TEXT NOT NULL,
  attempt_no INTEGER NOT NULL CHECK (attempt_no >= 1),
  recognizer_id TEXT NOT NULL,
  endpoint_kind TEXT NOT NULL CHECK (endpoint_kind IN ('edge', 'cloud')),
  start_offset_ms INTEGER NOT NULL CHECK (start_offset_ms >= 0),
  finish_offset_ms INTEGER NOT NULL CHECK (finish_offset_ms >= 0),
  wall_ms INTEGER NOT NULL CHECK (wall_ms >= 0),
  queued_ms INTEGER NOT NULL CHECK (queued_ms >= 0),
  outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'ambiguous', 'failed', 'timeout', 'cancelled')),
  predicted_intent_id TEXT,
  confidence_permille INTEGER CHECK (confidence_permille >= 0) CHECK (confidence_permille <= 1000),
  missing_required_slots INTEGER NOT NULL CHECK (missing_required_slots >= 0),
  context_used INTEGER NOT NULL CHECK (context_used IN (0, 1)),
  selected_for_dialogue INTEGER NOT NULL CHECK (selected_for_dialogue IN (0, 1)),
  error_code TEXT,
  received_at TEXT NOT NULL,
  PRIMARY KEY (nlu_attempt_id),
  UNIQUE (turn_id, attempt_no),
  CHECK (finish_offset_ms >= start_offset_ms),
  CHECK (wall_ms=finish_offset_ms-start_offset_ms),
  CHECK (queued_ms<=wall_ms),
  FOREIGN KEY (turn_id) REFERENCES syn_voice_turn(turn_id),
  FOREIGN KEY (hypothesis_id) REFERENCES syn_asr_hypothesis(hypothesis_id),
  FOREIGN KEY (recognizer_id) REFERENCES syn_recognizer_model(recognizer_id),
  FOREIGN KEY (predicted_intent_id) REFERENCES syn_intent_catalog(intent_id)
);

CREATE INDEX ix_syn_nlu_attempt_turn_id ON syn_nlu_attempt(turn_id);

CREATE INDEX ix_syn_nlu_attempt_hypothesis_id ON syn_nlu_attempt(hypothesis_id);

CREATE INDEX ix_syn_nlu_attempt_recognizer_id ON syn_nlu_attempt(recognizer_id);

CREATE INDEX ix_syn_nlu_attempt_predicted_intent_id ON syn_nlu_attempt(predicted_intent_id);

-- 槽位提取与补全：一次NLU尝试中的一个已声明槽位。
CREATE TABLE syn_slot_value (
  slot_id TEXT NOT NULL,
  nlu_attempt_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  slot_name TEXT NOT NULL,
  raw_value TEXT,
  normalized_value TEXT,
  value_kind TEXT NOT NULL CHECK (value_kind IN ('text', 'decimal', 'boolean')),
  value_unit TEXT,
  resolution_source TEXT NOT NULL CHECK (resolution_source IN ('utterance', 'context', 'default', 'missing')),
  confidence_permille INTEGER CHECK (confidence_permille >= 0) CHECK (confidence_permille <= 1000),
  is_required INTEGER NOT NULL CHECK (is_required IN (0, 1)),
  is_resolved INTEGER NOT NULL CHECK (is_resolved IN (0, 1)),
  validation_state TEXT NOT NULL CHECK (validation_state IN ('valid', 'missing', 'out_of_range', 'ambiguous')),
  source_turn_id TEXT,
  received_at TEXT NOT NULL,
  PRIMARY KEY (slot_id),
  UNIQUE (nlu_attempt_id, slot_name),
  FOREIGN KEY (nlu_attempt_id) REFERENCES syn_nlu_attempt(nlu_attempt_id),
  FOREIGN KEY (turn_id) REFERENCES syn_voice_turn(turn_id),
  FOREIGN KEY (source_turn_id) REFERENCES syn_voice_turn(turn_id)
);

CREATE INDEX ix_syn_slot_value_nlu_attempt_id ON syn_slot_value(nlu_attempt_id);

CREATE INDEX ix_syn_slot_value_turn_id ON syn_slot_value(turn_id);

CREATE INDEX ix_syn_slot_value_source_turn_id ON syn_slot_value(source_turn_id);

-- 对话状态变化：一轮内的一次对话状态迁移。
CREATE TABLE syn_dialogue_transition (
  transition_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  transition_no INTEGER NOT NULL CHECK (transition_no >= 1),
  from_state TEXT NOT NULL CHECK (from_state IN ('listening', 'understanding', 'awaiting_slot', 'ready', 'executing', 'completed', 'cancelled', 'failed', 'unknown', 'rejected', 'no_speech')),
  to_state TEXT NOT NULL CHECK (to_state IN ('listening', 'understanding', 'awaiting_slot', 'ready', 'executing', 'completed', 'cancelled', 'failed', 'unknown', 'rejected', 'no_speech')),
  reason TEXT NOT NULL CHECK (reason IN ('parsed', 'missing_slot', 'slot_filled', 'user_cancel', 'new_goal', 'action_receipt', 'timeout', 'policy_rejected', 'silence')),
  offset_ms INTEGER NOT NULL CHECK (offset_ms >= 0),
  context_turn_id TEXT,
  clarification_slot TEXT,
  clarification_text TEXT,
  user_decision TEXT NOT NULL CHECK (user_decision IN ('provided', 'cancelled', 'unanswered', 'not_required')),
  context_preserved INTEGER NOT NULL CHECK (context_preserved IN (0, 1)),
  received_at TEXT NOT NULL,
  PRIMARY KEY (transition_id),
  UNIQUE (turn_id, transition_no),
  FOREIGN KEY (turn_id) REFERENCES syn_voice_turn(turn_id),
  FOREIGN KEY (context_turn_id) REFERENCES syn_voice_turn(turn_id)
);

CREATE INDEX ix_syn_dialogue_transition_turn_id ON syn_dialogue_transition(turn_id);

CREATE INDEX ix_syn_dialogue_transition_context_turn_id ON syn_dialogue_transition(context_turn_id);

-- 能力路由尝试：一轮理解结果的一次技能路由。
CREATE TABLE syn_skill_route (
  route_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  nlu_attempt_id TEXT NOT NULL,
  attempt_no INTEGER NOT NULL CHECK (attempt_no >= 1),
  capability_id TEXT NOT NULL,
  intent_id TEXT NOT NULL,
  skill_code TEXT NOT NULL,
  route_kind TEXT NOT NULL CHECK (route_kind IN ('local', 'cloud', 'fallback')),
  start_offset_ms INTEGER NOT NULL CHECK (start_offset_ms >= 0),
  finish_offset_ms INTEGER NOT NULL CHECK (finish_offset_ms >= 0),
  wall_ms INTEGER NOT NULL CHECK (wall_ms >= 0),
  outcome TEXT NOT NULL CHECK (outcome IN ('selected', 'rejected', 'failed')),
  is_final_route INTEGER NOT NULL CHECK (is_final_route IN (0, 1)),
  reject_reason TEXT NOT NULL CHECK (reject_reason IN ('none', 'unsupported', 'missing_slot', 'policy', 'unavailable')),
  received_at TEXT NOT NULL,
  PRIMARY KEY (route_id),
  UNIQUE (turn_id, attempt_no),
  CHECK (finish_offset_ms >= start_offset_ms),
  CHECK (wall_ms=finish_offset_ms-start_offset_ms),
  FOREIGN KEY (turn_id) REFERENCES syn_voice_turn(turn_id),
  FOREIGN KEY (nlu_attempt_id) REFERENCES syn_nlu_attempt(nlu_attempt_id),
  FOREIGN KEY (capability_id) REFERENCES syn_voice_capability(capability_id),
  FOREIGN KEY (intent_id) REFERENCES syn_intent_catalog(intent_id)
);

CREATE INDEX ix_syn_skill_route_turn_id ON syn_skill_route(turn_id);

CREATE INDEX ix_syn_skill_route_nlu_attempt_id ON syn_skill_route(nlu_attempt_id);

CREATE INDEX ix_syn_skill_route_capability_id ON syn_skill_route(capability_id);

CREATE INDEX ix_syn_skill_route_intent_id ON syn_skill_route(intent_id);

-- 动作提交尝试：一个稳定operation的一次传输提交尝试。
CREATE TABLE syn_action_invocation (
  invocation_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  route_id TEXT NOT NULL,
  operation_key TEXT NOT NULL,
  attempt_no INTEGER NOT NULL CHECK (attempt_no >= 1),
  action_name TEXT NOT NULL,
  argument_name TEXT NOT NULL,
  argument_value TEXT,
  argument_unit TEXT,
  submitted_offset_ms INTEGER NOT NULL CHECK (submitted_offset_ms >= 0),
  deadline_offset_ms INTEGER NOT NULL CHECK (deadline_offset_ms >= 0),
  transport_kind TEXT NOT NULL CHECK (transport_kind IN ('local_bus', 'simulated_cloud')),
  acceptance_state TEXT NOT NULL CHECK (acceptance_state IN ('accepted', 'rejected', 'unknown')),
  idempotency_supported INTEGER NOT NULL CHECK (idempotency_supported IN (0, 1)),
  timeout_ms INTEGER NOT NULL CHECK (timeout_ms >= 0),
  received_at TEXT NOT NULL,
  PRIMARY KEY (invocation_id),
  UNIQUE (operation_key, attempt_no),
  CHECK (deadline_offset_ms >= submitted_offset_ms),
  CHECK (idempotency_supported=1),
  FOREIGN KEY (turn_id) REFERENCES syn_voice_turn(turn_id),
  FOREIGN KEY (route_id) REFERENCES syn_skill_route(route_id)
);

CREATE INDEX ix_syn_action_invocation_turn_id ON syn_action_invocation(turn_id);

CREATE INDEX ix_syn_action_invocation_route_id ON syn_action_invocation(route_id);

-- 动作执行与效果回执：一次提交对应的一条结果观测，可先unknown后明确。
CREATE TABLE syn_action_result (
  result_id TEXT NOT NULL,
  invocation_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  operation_key TEXT NOT NULL,
  observation_no INTEGER NOT NULL CHECK (observation_no >= 1),
  observed_offset_ms INTEGER NOT NULL CHECK (observed_offset_ms >= 0),
  return_state TEXT NOT NULL CHECK (return_state IN ('succeeded', 'failed', 'cancelled', 'unknown')),
  effect_state TEXT NOT NULL CHECK (effect_state IN ('confirmed', 'not_observed', 'unknown')),
  effect_instance_id TEXT,
  result_value TEXT,
  result_unit TEXT,
  error_code TEXT,
  replayed_receipt INTEGER NOT NULL CHECK (replayed_receipt IN (0, 1)),
  server_elapsed_ms INTEGER CHECK (server_elapsed_ms >= 0),
  received_at TEXT NOT NULL,
  PRIMARY KEY (result_id),
  UNIQUE (invocation_id, observation_no),
  CHECK (effect_state<>'confirmed' OR (return_state='succeeded' AND effect_instance_id IS NOT NULL)),
  FOREIGN KEY (invocation_id) REFERENCES syn_action_invocation(invocation_id),
  FOREIGN KEY (turn_id) REFERENCES syn_voice_turn(turn_id)
);

CREATE INDEX ix_syn_action_result_invocation_id ON syn_action_result(invocation_id);

CREATE INDEX ix_syn_action_result_turn_id ON syn_action_result(turn_id);

-- 播报合成请求：一轮中的一次模拟文本合成请求。
CREATE TABLE syn_tts_request (
  tts_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  action_result_id TEXT,
  attempt_no INTEGER NOT NULL CHECK (attempt_no >= 1),
  response_kind TEXT NOT NULL CHECK (response_kind IN ('answer', 'clarification', 'error', 'status')),
  response_text TEXT NOT NULL,
  voice_profile TEXT NOT NULL CHECK (voice_profile IN ('synthetic_voice_a', 'synthetic_voice_b')),
  endpoint_kind TEXT NOT NULL CHECK (endpoint_kind IN ('edge', 'cloud')),
  start_offset_ms INTEGER NOT NULL CHECK (start_offset_ms >= 0),
  first_chunk_offset_ms INTEGER CHECK (first_chunk_offset_ms >= 0),
  finish_offset_ms INTEGER NOT NULL CHECK (finish_offset_ms >= 0),
  wall_ms INTEGER NOT NULL CHECK (wall_ms >= 0),
  simulated_audio_ms INTEGER NOT NULL CHECK (simulated_audio_ms >= 0),
  outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed', 'timeout', 'cancelled')),
  error_code TEXT,
  received_at TEXT NOT NULL,
  PRIMARY KEY (tts_id),
  UNIQUE (turn_id, attempt_no),
  CHECK (finish_offset_ms>=start_offset_ms),
  CHECK (wall_ms=finish_offset_ms-start_offset_ms),
  FOREIGN KEY (turn_id) REFERENCES syn_voice_turn(turn_id),
  FOREIGN KEY (action_result_id) REFERENCES syn_action_result(result_id)
);

CREATE INDEX ix_syn_tts_request_turn_id ON syn_tts_request(turn_id);

CREATE INDEX ix_syn_tts_request_action_result_id ON syn_tts_request(action_result_id);

-- 播报播放片段：一次TTS结果的一段实际模拟播放。
CREATE TABLE syn_playback_segment (
  playback_id TEXT NOT NULL,
  tts_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  segment_no INTEGER NOT NULL CHECK (segment_no >= 1),
  output_zone TEXT NOT NULL CHECK (output_zone IN ('driver', 'front', 'all')),
  start_offset_ms INTEGER NOT NULL CHECK (start_offset_ms >= 0),
  finish_offset_ms INTEGER NOT NULL CHECK (finish_offset_ms >= 0),
  planned_ms INTEGER NOT NULL CHECK (planned_ms >= 0),
  played_ms INTEGER NOT NULL CHECK (played_ms >= 0),
  buffering_ms INTEGER NOT NULL CHECK (buffering_ms >= 0),
  end_reason TEXT NOT NULL CHECK (end_reason IN ('completed', 'barge_in', 'user_stop', 'device_error')),
  completion_state TEXT NOT NULL CHECK (completion_state IN ('complete', 'interrupted', 'failed')),
  volume_pct INTEGER NOT NULL CHECK (volume_pct >= 0) CHECK (volume_pct <= 100),
  received_at TEXT NOT NULL,
  PRIMARY KEY (playback_id),
  UNIQUE (tts_id, segment_no),
  CHECK (finish_offset_ms >= start_offset_ms),
  CHECK (played_ms <= planned_ms),
  CHECK (finish_offset_ms-start_offset_ms=played_ms+buffering_ms),
  FOREIGN KEY (tts_id) REFERENCES syn_tts_request(tts_id),
  FOREIGN KEY (turn_id) REFERENCES syn_voice_turn(turn_id)
);

CREATE INDEX ix_syn_playback_segment_tts_id ON syn_playback_segment(tts_id);

CREATE INDEX ix_syn_playback_segment_turn_id ON syn_playback_segment(turn_id);

-- 播报打断事件：对某条播放片段的一次打断观测。
CREATE TABLE syn_interruption_event (
  interruption_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  interrupted_turn_id TEXT NOT NULL,
  playback_id TEXT NOT NULL,
  triggering_turn_id TEXT,
  occurred_at TEXT NOT NULL,
  trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('new_utterance', 'button_stop', 'policy')),
  offset_in_playback_ms INTEGER NOT NULL CHECK (offset_in_playback_ms >= 0),
  stop_latency_ms INTEGER NOT NULL CHECK (stop_latency_ms >= 0),
  stop_confirmed INTEGER NOT NULL CHECK (stop_confirmed IN (0, 1)),
  action_was_already_confirmed INTEGER NOT NULL CHECK (action_was_already_confirmed IN (0, 1)),
  context_policy TEXT NOT NULL CHECK (context_policy IN ('carry', 'replace', 'clear')),
  received_at TEXT NOT NULL,
  PRIMARY KEY (interruption_id),
  FOREIGN KEY (session_id) REFERENCES syn_voice_session(session_id),
  FOREIGN KEY (interrupted_turn_id) REFERENCES syn_voice_turn(turn_id),
  FOREIGN KEY (playback_id) REFERENCES syn_playback_segment(playback_id),
  FOREIGN KEY (triggering_turn_id) REFERENCES syn_voice_turn(turn_id)
);

CREATE INDEX ix_syn_interruption_event_session_id ON syn_interruption_event(session_id);

CREATE INDEX ix_syn_interruption_event_interrupted_turn_id ON syn_interruption_event(interrupted_turn_id);

CREATE INDEX ix_syn_interruption_event_playback_id ON syn_interruption_event(playback_id);

CREATE INDEX ix_syn_interruption_event_triggering_turn_id ON syn_interruption_event(triggering_turn_id);

-- 交互反馈：一条用户轮次的一份可选合成明确反馈。
CREATE TABLE syn_turn_feedback (
  feedback_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  collected_at TEXT NOT NULL,
  rating TEXT NOT NULL CHECK (rating IN ('positive', 'neutral', 'negative')),
  reason_category TEXT NOT NULL CHECK (reason_category IN ('correct', 'wrong_action', 'slow', 'no_response', 'stopped', 'unclear')),
  feedback_source TEXT NOT NULL CHECK (feedback_source IN ('synthetic_authored')),
  is_explicit INTEGER NOT NULL CHECK (is_explicit IN (0, 1)),
  comment_text TEXT,
  rating_scale_revision INTEGER NOT NULL CHECK (rating_scale_revision >= 1),
  received_at TEXT NOT NULL,
  quality_state TEXT NOT NULL CHECK (quality_state IN ('valid', 'invalid')),
  PRIMARY KEY (feedback_id),
  UNIQUE (turn_id),
  CHECK (is_explicit=1),
  FOREIGN KEY (turn_id) REFERENCES syn_voice_turn(turn_id)
);

CREATE INDEX ix_syn_turn_feedback_turn_id ON syn_turn_feedback(turn_id);

-- 语音链路网络观测：一个会话内的网络状态采样。
CREATE TABLE syn_network_observation (
  network_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  turn_id TEXT,
  observed_at TEXT NOT NULL,
  transport TEXT NOT NULL CHECK (transport IN ('cellular', 'wifi', 'none')),
  reachability TEXT NOT NULL CHECK (reachability IN ('online', 'offline', 'degraded')),
  rtt_ms INTEGER CHECK (rtt_ms >= 0),
  loss_permille INTEGER CHECK (loss_permille >= 0) CHECK (loss_permille <= 1000),
  signal_bucket TEXT NOT NULL CHECK (signal_bucket IN ('weak', 'fair', 'good', 'not_applicable')),
  endpoint_scope TEXT NOT NULL CHECK (endpoint_scope IN ('voice_cloud', 'general')),
  network_label TEXT NOT NULL,
  received_at TEXT NOT NULL,
  quality_state TEXT NOT NULL CHECK (quality_state IN ('valid', 'invalid')),
  PRIMARY KEY (network_id),
  FOREIGN KEY (session_id) REFERENCES syn_voice_session(session_id),
  FOREIGN KEY (turn_id) REFERENCES syn_voice_turn(turn_id)
);

CREATE INDEX ix_syn_network_observation_session_id ON syn_network_observation(session_id);

CREATE INDEX ix_syn_network_observation_turn_id ON syn_network_observation(turn_id);

-- 交互链路错误事件：一条可定位到轮次/阶段的合成错误观测。
CREATE TABLE syn_error_event (
  error_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  turn_id TEXT,
  stage TEXT NOT NULL CHECK (stage IN ('wakeup', 'frontend', 'asr', 'nlu', 'dialogue', 'route', 'action', 'tts', 'playback', 'network')),
  related_record_id TEXT,
  occurred_at TEXT NOT NULL,
  error_code TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'error')),
  retryable INTEGER NOT NULL CHECK (retryable IN (0, 1)),
  recovery_action TEXT NOT NULL CHECK (recovery_action IN ('none', 'retry', 'edge_fallback', 'clarify', 'query_receipt', 'stop_playback')),
  recovery_state TEXT NOT NULL CHECK (recovery_state IN ('not_started', 'succeeded', 'failed', 'unknown')),
  detail_text TEXT NOT NULL,
  received_at TEXT NOT NULL,
  quality_state TEXT NOT NULL CHECK (quality_state IN ('valid', 'invalid')),
  PRIMARY KEY (error_id),
  FOREIGN KEY (session_id) REFERENCES syn_voice_session(session_id),
  FOREIGN KEY (turn_id) REFERENCES syn_voice_turn(turn_id)
);

CREATE INDEX ix_syn_error_event_session_id ON syn_error_event(session_id);

CREATE INDEX ix_syn_error_event_turn_id ON syn_error_event(turn_id);

-- 语音交互日体验汇总：一个UTC活动日、车辆及各事实冻结build的并列计数。
CREATE TABLE syn_daily_voice_experience (
  activity_date TEXT NOT NULL,
  vehicle_id TEXT NOT NULL,
  build_id TEXT NOT NULL,
  session_count INTEGER NOT NULL CHECK (session_count >= 0),
  wakeup_attempt_count INTEGER NOT NULL CHECK (wakeup_attempt_count >= 0),
  wakeup_accepted_count INTEGER NOT NULL CHECK (wakeup_accepted_count >= 0),
  wakeup_labeled_count INTEGER NOT NULL CHECK (wakeup_labeled_count >= 0),
  wakeup_false_accept_count INTEGER NOT NULL CHECK (wakeup_false_accept_count >= 0),
  turn_count INTEGER NOT NULL CHECK (turn_count >= 0),
  eligible_turn_count INTEGER NOT NULL CHECK (eligible_turn_count >= 0),
  task_completed_count INTEGER NOT NULL CHECK (task_completed_count >= 0),
  clarification_count INTEGER NOT NULL CHECK (clarification_count >= 0),
  failed_turn_count INTEGER NOT NULL CHECK (failed_turn_count >= 0),
  unknown_turn_count INTEGER NOT NULL CHECK (unknown_turn_count >= 0),
  cancelled_turn_count INTEGER NOT NULL CHECK (cancelled_turn_count >= 0),
  no_speech_turn_count INTEGER NOT NULL CHECK (no_speech_turn_count >= 0),
  rejected_turn_count INTEGER NOT NULL CHECK (rejected_turn_count >= 0),
  completed_latency_sum_ms INTEGER NOT NULL CHECK (completed_latency_sum_ms >= 0),
  completed_latency_samples INTEGER NOT NULL CHECK (completed_latency_samples >= 0),
  first_audio_latency_sum_ms INTEGER NOT NULL CHECK (first_audio_latency_sum_ms >= 0),
  first_audio_samples INTEGER NOT NULL CHECK (first_audio_samples >= 0),
  asr_labeled_turn_count INTEGER NOT NULL CHECK (asr_labeled_turn_count >= 0),
  asr_exact_match_count INTEGER NOT NULL CHECK (asr_exact_match_count >= 0),
  intent_labeled_turn_count INTEGER NOT NULL CHECK (intent_labeled_turn_count >= 0),
  intent_match_count INTEGER NOT NULL CHECK (intent_match_count >= 0),
  feedback_count INTEGER NOT NULL CHECK (feedback_count >= 0),
  positive_feedback_count INTEGER NOT NULL CHECK (positive_feedback_count >= 0),
  playback_interruption_count INTEGER NOT NULL CHECK (playback_interruption_count >= 0),
  snapshot_exclusive TEXT NOT NULL,
  PRIMARY KEY (activity_date, vehicle_id, build_id),
  CHECK (wakeup_accepted_count<=wakeup_attempt_count),
  CHECK (wakeup_false_accept_count<=wakeup_labeled_count),
  CHECK (eligible_turn_count=task_completed_count+clarification_count+failed_turn_count+unknown_turn_count+rejected_turn_count),
  CHECK (turn_count=eligible_turn_count+cancelled_turn_count+no_speech_turn_count),
  CHECK (asr_exact_match_count<=asr_labeled_turn_count),
  CHECK (intent_match_count<=intent_labeled_turn_count),
  CHECK (positive_feedback_count<=feedback_count),
  FOREIGN KEY (vehicle_id) REFERENCES syn_vehicle(vehicle_id),
  FOREIGN KEY (build_id) REFERENCES syn_software_build(build_id)
);

CREATE INDEX ix_syn_daily_voice_experience_vehicle_id ON syn_daily_voice_experience(vehicle_id);

CREATE INDEX ix_syn_daily_voice_experience_build_id ON syn_daily_voice_experience(build_id);

-- 语音阶段日尝试汇总：一个轮次归属日、阶段、端云位置与build的统计。
CREATE TABLE syn_daily_stage_latency (
  turn_date TEXT NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('asr', 'nlu', 'route', 'action', 'tts')),
  endpoint_kind TEXT NOT NULL CHECK (endpoint_kind IN ('edge', 'cloud')),
  build_id TEXT NOT NULL,
  attempt_count INTEGER NOT NULL CHECK (attempt_count >= 0),
  distinct_turn_count INTEGER NOT NULL CHECK (distinct_turn_count >= 0),
  succeeded_attempt_count INTEGER NOT NULL CHECK (succeeded_attempt_count >= 0),
  failed_attempt_count INTEGER NOT NULL CHECK (failed_attempt_count >= 0),
  timeout_attempt_count INTEGER NOT NULL CHECK (timeout_attempt_count >= 0),
  cancelled_attempt_count INTEGER NOT NULL CHECK (cancelled_attempt_count >= 0),
  unknown_attempt_count INTEGER NOT NULL CHECK (unknown_attempt_count >= 0),
  ambiguous_attempt_count INTEGER NOT NULL CHECK (ambiguous_attempt_count >= 0),
  rejected_attempt_count INTEGER NOT NULL CHECK (rejected_attempt_count >= 0),
  latency_sum_ms INTEGER NOT NULL CHECK (latency_sum_ms >= 0),
  latency_samples INTEGER NOT NULL CHECK (latency_samples >= 0),
  latency_min_ms INTEGER CHECK (latency_min_ms >= 0),
  latency_max_ms INTEGER CHECK (latency_max_ms >= 0),
  queued_sum_ms INTEGER NOT NULL CHECK (queued_sum_ms >= 0),
  snapshot_exclusive TEXT NOT NULL,
  PRIMARY KEY (turn_date, stage, endpoint_kind, build_id),
  CHECK (attempt_count=succeeded_attempt_count+failed_attempt_count+timeout_attempt_count+cancelled_attempt_count+unknown_attempt_count+ambiguous_attempt_count+rejected_attempt_count),
  CHECK (distinct_turn_count<=attempt_count),
  CHECK (latency_samples<=attempt_count),
  FOREIGN KEY (build_id) REFERENCES syn_software_build(build_id)
);

CREATE INDEX ix_syn_daily_stage_latency_build_id ON syn_daily_stage_latency(build_id);

-- 已选意图日结果汇总：一个轮次归属日、最终预测意图与build的统计。
CREATE TABLE syn_daily_intent_outcome (
  turn_date TEXT NOT NULL,
  intent_id TEXT NOT NULL,
  capability_id TEXT NOT NULL,
  build_id TEXT NOT NULL,
  selected_turn_count INTEGER NOT NULL CHECK (selected_turn_count >= 0),
  task_completed_count INTEGER NOT NULL CHECK (task_completed_count >= 0),
  clarification_count INTEGER NOT NULL CHECK (clarification_count >= 0),
  rejected_count INTEGER NOT NULL CHECK (rejected_count >= 0),
  failed_count INTEGER NOT NULL CHECK (failed_count >= 0),
  cancelled_count INTEGER NOT NULL CHECK (cancelled_count >= 0),
  unknown_count INTEGER NOT NULL CHECK (unknown_count >= 0),
  no_speech_count INTEGER NOT NULL CHECK (no_speech_count >= 0),
  logical_action_count INTEGER NOT NULL CHECK (logical_action_count >= 0),
  confirmed_effect_count INTEGER NOT NULL CHECK (confirmed_effect_count >= 0),
  feedback_count INTEGER NOT NULL CHECK (feedback_count >= 0),
  positive_feedback_count INTEGER NOT NULL CHECK (positive_feedback_count >= 0),
  snapshot_exclusive TEXT NOT NULL,
  PRIMARY KEY (turn_date, intent_id, build_id),
  CHECK (selected_turn_count=task_completed_count+clarification_count+rejected_count+failed_count+cancelled_count+unknown_count+no_speech_count),
  CHECK (confirmed_effect_count<=logical_action_count),
  CHECK (positive_feedback_count<=feedback_count),
  FOREIGN KEY (intent_id) REFERENCES syn_intent_catalog(intent_id),
  FOREIGN KEY (capability_id) REFERENCES syn_voice_capability(capability_id),
  FOREIGN KEY (build_id) REFERENCES syn_software_build(build_id)
);

CREATE INDEX ix_syn_daily_intent_outcome_intent_id ON syn_daily_intent_outcome(intent_id);

CREATE INDEX ix_syn_daily_intent_outcome_capability_id ON syn_daily_intent_outcome(capability_id);

CREATE INDEX ix_syn_daily_intent_outcome_build_id ON syn_daily_intent_outcome(build_id);

CREATE UNIQUE INDEX ix_syn_asr_hypothesis_selected ON syn_asr_hypothesis(turn_id) WHERE selected_for_nlu=1;

CREATE UNIQUE INDEX ix_syn_nlu_attempt_selected ON syn_nlu_attempt(turn_id) WHERE selected_for_dialogue=1;

CREATE UNIQUE INDEX ix_syn_skill_route_selected ON syn_skill_route(turn_id) WHERE is_final_route=1;
