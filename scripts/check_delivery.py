#!/usr/bin/env python3
"""校验本轮交付声明；--complete 显式执行本地验收，不替用户判断业务质量。"""

from __future__ import annotations

import argparse
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import signal
import subprocess
import sys
import time


REQUIREMENTS = {f'{prefix}{n:02}' for prefix, count in [('D', 18), ('C', 8), ('A', 10)] for n in range(1, count + 1)}
MODULES = {f'M{n:02}' for n in range(1, 13)}
PHASES = {'I0', 'I1', 'I2', 'I3'}
MATERIAL_COMMANDS = {'verify-materials', 'verify-delivery', 'verify-increment', 'check_preparation.py',
                     'check-implementation.py', 'render-implementation.mjs', 'check_delivery.py',
                     'scripts.check_delivery'}
PRIVATE_PARTS = {'.git', '.private', '.migration', '.ssh', '.aws', 'secrets', 'credentials'}
PRIVATE_FILES = {'.netrc', '.npmrc', '.git-credentials', 'id_rsa', 'id_ed25519'}
BUILD_DIRS = {'node_modules', 'target', 'dist', '.cache', '.vite', '.pytest_cache', '__pycache__', '.local'}
LIMITATION = '本地证据只绑定声明范围；不识别任意包装脚本或未声明文件，不判断断言充分性，不防同权限篡改，不替代模型/网络授权，也不标记整体 I0/MVP 完成。'


class DeliveryError(Exception):
    pass


def require(ok: bool, message: str) -> None:
    if not ok:
        raise DeliveryError(message)


def text(value: object, label: str) -> str:
    require(isinstance(value, str) and bool(value.strip()), f'{label} 必须为非空字符串')
    return value


def strings(value: object, label: str) -> list[str]:
    require(isinstance(value, list) and bool(value), f'{label} 必须为非空数组')
    for item in value:
        text(item, label)
    require(len(value) == len(set(value)), f'{label} 不能重复')
    return value


def safe_path(root: Path, value: object) -> Path:
    name = text(value, '路径')
    relative = PurePosixPath(name)
    require(not relative.is_absolute() and relative.parts and '..' not in relative.parts
            and '\\' not in name and ':' not in name and name.rstrip('/') == str(relative)
            and name != '.', f'路径必须限定在项目相对范围：{name}')
    for part in relative.parts:
        low = part.lower()
        require(low not in PRIVATE_PARTS and low not in PRIVATE_FILES
                and not (low.startswith('.env') and low != '.env.example')
                and not low.endswith(('.pem', '.key', '.p12', '.pfx')), f'拒绝敏感路径：{name}')
    path = root
    for part in relative.parts:
        path = path / part
        require(not path.is_symlink(), f'不读取符号链接：{name}')
    require(path.resolve().is_relative_to(root), f'路径越界：{name}')
    return path


def read_delivery(root: Path) -> dict:
    current = safe_path(root, 'docs/CURRENT.md')
    content = current.read_text(encoding='utf-8')
    match = re.match(r'\A---\s*\n(\{.*?\})\s*\n---(?:\n|$)', content, re.S)
    require(match is not None, 'CURRENT.md 缺少 JSON frontmatter')
    metadata = json.loads(match.group(1))
    require(isinstance(metadata, dict), 'CURRENT frontmatter 必须为 JSON 对象')
    delivery = metadata.get('delivery')
    require(isinstance(delivery, dict) and delivery.get('schema') == 1, 'delivery.schema 必须为 1')
    return delivery


def registry_rows(root: Path, relative: str) -> dict[str, list[str]]:
    content = safe_path(root, relative).read_text(encoding='utf-8')
    rows = {}
    for line in content.splitlines():
        columns = [cell.strip() for cell in line.strip().strip('|').split('|')]
        if not line.startswith('|') or not re.fullmatch(r'[DCA]\d{2}', columns[0]):
            continue
        key = columns[0]
        require(key not in rows, f'registry 编号重复：{key}')
        require(len(columns) == 6 and all(columns), f'registry {key} 必须有六个非空字段')
        phases = re.findall(r'\bI\d+\b', columns[2])
        modules = re.findall(r'\bM\d+\b', columns[3])
        require(bool(phases) and set(phases) <= PHASES, f'registry {key} 完成阶段无效')
        require(bool(modules) and set(modules) <= MODULES, f'registry {key} 模块无效')
        rows[key] = columns
    require(set(rows) == REQUIREMENTS, 'registry 必须完整且仅覆盖 D01–D18、C01–C08、A01–A10')
    return rows


def decisions_digest(root: Path) -> str:
    content = safe_path(root, 'docs/CURRENT.md').read_text(encoding='utf-8')
    section = re.search(r'^## 已确认的 18 项决定\s*\n(.*?)(?=^## |\Z)', content, re.M | re.S)
    require(section is not None and bool(section.group(1).strip()), 'CURRENT 缺少“已确认的 18 项决定”正文段')
    return digest(section.group(0).encode())


def validate(root: Path, delivery: dict, complete: bool = False) -> dict:
    registry_rows(root, text(delivery.get('registry'), 'delivery.registry'))
    decisions_digest(root)
    increment = delivery.get('increment')
    require(isinstance(increment, dict), '缺少 delivery.increment')
    identifier = text(increment.get('id'), 'increment.id')
    require(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,79}', identifier) is not None, 'increment.id 不是安全标识')
    require(increment.get('phase') in PHASES, 'increment.phase 必须为 I0–I3')
    require(increment.get('status') in {'planned', 'active', 'complete'}, 'increment.status 无效')
    text(increment.get('goal'), 'increment.goal')
    selected = set(strings(increment.get('requirements'), 'increment.requirements'))
    require(selected <= REQUIREMENTS, '本轮存在未知 requirement ID')
    require(set(strings(increment.get('modules'), 'increment.modules')) <= MODULES, '本轮模块无效')
    for key in ['non_goals', 'invariants']:
        strings(increment.get(key), f'increment.{key}')
    for name in strings(increment.get('allowed_paths'), 'increment.allowed_paths'):
        safe_path(root, name)
    for name in strings(increment.get('verification_inputs'), 'increment.verification_inputs'):
        safe_path(root, name)
        require(name != '.local' and not name.startswith('.local/delivery'), '验收输入不能包含收据目录')
    acceptance = increment.get('acceptance')
    require(isinstance(acceptance, list) and bool(acceptance), '必须声明 acceptance')
    covered, ids = set(), set()
    for check in acceptance:
        require(isinstance(check, dict), 'acceptance 条目必须为对象')
        check_id = text(check.get('id'), 'acceptance.id')
        require(check_id not in ids, f'acceptance ID 重复：{check_id}')
        ids.add(check_id)
        requirements = set(strings(check.get('requirements'), f'{check_id}.requirements'))
        require(requirements <= selected, f'{check_id} 引用了非本轮 requirement')
        covered.update(requirements)
        text(check.get('expected'), f'{check_id}.expected')
        require(check.get('evidence_kind') in {'runtime', 'contract', 'architecture'}, f'{check_id}.evidence_kind 无效')
        timeout = check.get('timeout_seconds')
        require(isinstance(timeout, (int, float)) and not isinstance(timeout, bool)
                and math.isfinite(timeout) and timeout > 0, f'{check_id}.timeout_seconds 必须为正数')
        require('command' in check, f'{check_id} 缺 command；待实现时明确写 null')
        command = check['command']
        if command is not None:
            require(isinstance(command, list) and bool(command), f'{check_id}.command 必须为 argv 数组')
            for arg in command:
                text(arg, f'{check_id}.command')
        if complete:
            require(command is not None, f'{check_id} 缺可执行 command，业务未验证')
            words = {Path(arg).name for arg in command}
            require(not words.intersection(MATERIAL_COMMANDS)
                    and not (Path(command[0]).name == 'make' and 'verify' in command)
                    and not ('gate' in words and any('dev_co' in arg for arg in command)),
                    f'{check_id} 的材料/图册/检查器命令不能作为业务完成验收')
    require(covered == selected, '存在未绑定 acceptance 的本轮 requirement')
    review = increment.get('review')
    require(isinstance(review, dict) and review.get('status') in {'pending', 'passed'}, 'review.status 无效')
    require('record' in review and 'evidence' in increment, '必须显式声明 review.record 和 evidence，可暂为 null')
    if review['record'] is not None:
        safe_path(root, review['record'])
    if increment['evidence'] is not None:
        safe_path(root, increment['evidence'])
    if complete:
        require(review['status'] == 'passed' and review['record'] is not None, '缺少已通过的审查记录')
        record = safe_path(root, review['record'])
        require(record.is_file() and record.stat().st_size > 0, '审查记录不存在或为空')
    return increment


def canonical(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()


def digest(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def contract_digest(delivery: dict, exclude_review: bool = False) -> str:
    normalized = deepcopy(delivery)
    for field in ['status', 'evidence']:
        normalized['increment'].pop(field, None)
    if exclude_review:
        normalized['increment'].pop('review', None)
    return digest(canonical(normalized))


def fingerprint(root: Path, delivery: dict, for_review: bool = False) -> dict:
    increment = delivery['increment']
    review_record = increment['review']['record']
    paths = [delivery['registry'], 'AGENTS.md', *increment['verification_inputs']]
    if not for_review:
        paths.append(review_record)
    files, declarations = {}, {}
    for relative in paths:
        if for_review and relative == review_record:
            continue
        path = safe_path(root, relative)
        require(path.exists(), f'缺少实际验收输入：{relative}')
        declarations[relative] = 'directory' if path.is_dir() else 'file'
        # 只遍历声明目录；先检查路径再读内容，拒绝符号链接与凭据。
        pending = [path]
        found = 0
        while pending:
            candidate = pending.pop()
            if (candidate.name in BUILD_DIRS and candidate.is_dir()) or candidate.suffix == '.pyc' or candidate.name == '.DS_Store':
                continue
            name = candidate.relative_to(root).as_posix()
            if for_review and name == review_record:
                continue
            candidate = safe_path(root, name)
            if candidate.is_dir():
                pending.extend(sorted(candidate.iterdir()))
            else:
                require(candidate.is_file(), f'输入不是普通文件：{name}')
                content = candidate.read_bytes()
                if name == 'docs/CURRENT.md':
                    # CURRENT 的交付状态和收据指针不能形成自引用指纹。
                    raw = content.decode('utf-8')
                    front = re.match(r'\A---\s*\n(\{.*?\})\s*\n---(?:\n|$)', raw, re.S)
                    require(front is not None, 'CURRENT.md 缺少 JSON frontmatter')
                    metadata = json.loads(front.group(1))
                    for field in ['status', 'evidence']:
                        metadata['delivery']['increment'].pop(field, None)
                    if for_review:
                        metadata['delivery']['increment'].pop('review', None)
                    content = canonical(metadata) + raw[front.end():].encode()
                files[name] = digest(content)
                found += 1
        require(found > 0, f'验收输入为空目录：{relative}')
    return {'contract_sha256': contract_digest(delivery, exclude_review=for_review),
            'decisions_sha256': decisions_digest(root), 'files': files, 'declarations': declarations,
            'checker_sha256': digest(Path(__file__).read_bytes())}


def review_scope(root: Path, delivery: dict) -> str:
    """供本地审查者生成范围摘要；排除审查记录及指针，不自行声称审查已通过。"""
    return digest(canonical(fingerprint(root.resolve(), delivery, for_review=True)))


def verify_review(root: Path, delivery: dict) -> None:
    record = json.loads(safe_path(root, delivery['increment']['review']['record']).read_text(encoding='utf-8'))
    require(isinstance(record, dict), '审查记录必须是 JSON 对象')
    text(record.get('reviewer'), 'review.reviewer')
    text(record.get('summary'), 'review.summary')
    require(record.get('conclusion') == 'passed', '审查结论未通过')
    require(record.get('scope_sha256') == review_scope(root, delivery), '审查证据已过期：范围指纹不一致')


def command_groups(increment: dict) -> list[dict]:
    groups = {}
    for check in increment['acceptance']:
        key = tuple(check['command'])
        if key not in groups:
            groups[key] = {'argv': list(key), 'acceptance_ids': [], 'timeout_seconds': check['timeout_seconds']}
        groups[key]['acceptance_ids'].append(check['id'])
        groups[key]['timeout_seconds'] = min(groups[key]['timeout_seconds'], check['timeout_seconds'])
    return list(groups.values())


def run_command(root: Path, group: dict, log_path: str) -> dict:
    started = time.monotonic()
    result = {**group, 'log': log_path, 'exit_code': None, 'timed_out': False, 'passed': False}
    try:
        destination = safe_path(root, log_path)
        destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        # 输出留在忽略的本地目录，便于定位失败；不将日志正文写入公开收据或终端。
        with os.fdopen(os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb') as output:
            process = subprocess.Popen(group['argv'], cwd=root, stdout=output, stderr=subprocess.STDOUT,
                                       start_new_session=os.name == 'posix')
        try:
            process.wait(timeout=group['timeout_seconds'])
        except subprocess.TimeoutExpired:
            result['timed_out'] = True
            if os.name == 'posix':
                os.killpg(process.pid, signal.SIGKILL)
            else:
                process.kill()
            process.wait()
        except KeyboardInterrupt:
            if os.name == 'posix':
                os.killpg(process.pid, signal.SIGKILL)
            else:
                process.kill()
            process.wait()
            raise
        result['exit_code'] = process.returncode
        result['passed'] = process.returncode == 0 and not result['timed_out']
    except OSError as error:
        result['error'] = f'命令无法启动：{error.__class__.__name__}'
    result['duration_ms'] = round((time.monotonic() - started) * 1000)
    return result


def verify_receipt(root: Path, delivery: dict, current: dict) -> str:
    increment = delivery['increment']
    expected_path = f'.local/delivery/{increment["id"]}-result.json'
    require(increment['evidence'] == expected_path, 'complete 必须引用本轮生成的指定收据路径')
    receipt = json.loads(safe_path(root, expected_path).read_text(encoding='utf-8'))
    require(isinstance(receipt, dict) and receipt.get('schema') == 1
            and receipt.get('kind') == 'executed_delivery' and receipt.get('status') == 'passed'
            and receipt.get('increment_id') == increment['id'], '收据不是本轮完整执行成功记录')
    require(receipt.get('before') == current and receipt.get('after') == current, '交付证据已过期：契约或输入指纹不一致')
    require(bool(receipt.get('started_at')) and bool(receipt.get('finished_at')), '收据缺执行时间')
    results, groups = receipt.get('commands'), command_groups(increment)
    require(isinstance(results, list) and len(results) == len(groups), '收据未覆盖所有不同验收命令')
    for result, group in zip(results, groups):
        require(isinstance(result, dict) and all(result.get(k) == v for k, v in group.items())
                and result.get('passed') is True and result.get('exit_code') == 0
                and result.get('timed_out') is False and isinstance(result.get('duration_ms'), int)
                and result['duration_ms'] >= 0, '收据存在缺失、失败或不匹配命令')
    return expected_path


def complete_delivery(root: Path, delivery: dict, before: dict) -> tuple[bool, str]:
    increment = delivery['increment']
    report = {'schema': 1, 'kind': 'executed_delivery', 'increment_id': increment['id'],
              'started_at': datetime.now(timezone.utc).isoformat(), 'before': before,
              'commands': [], 'after': None, 'status': 'running', 'limitation': LIMITATION}
    relative = f'.local/delivery/{increment["id"]}-result.json'
    write_report(root, relative, report)
    log_directory = f'.local/delivery/{increment["id"]}-{time.time_ns()}'
    for index, group in enumerate(command_groups(increment), start=1):
        result = run_command(root, group, f'{log_directory}/command-{index:02}.log')
        report['commands'].append(result)
        if not result['passed']:
            break
    try:
        report['after'] = fingerprint(root, read_delivery(root))
        require(report['after'] == before, '验收执行期间契约、审查记录或输入发生变化')
        require(len(report['commands']) == len(command_groups(increment))
                and all(result['passed'] for result in report['commands']), '验收命令失败、未完成或超时')
        report['status'] = 'passed'
    except (DeliveryError, OSError, ValueError, TypeError, KeyError) as error:
        report['status'] = 'failed'
        report['error'] = str(error)
    report['finished_at'] = datetime.now(timezone.utc).isoformat()
    write_report(root, relative, report)
    return report['status'] == 'passed', relative


def write_report(root: Path, relative: str, report: dict) -> None:
    destination = safe_path(root, relative)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = safe_path(root, relative + '.tmp')
    temporary.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    temporary.replace(destination)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--complete', action='store_true', help='显式执行已声明命令并保存内容指纹收据')
    args = parser.parse_args(argv)
    root = args.root.resolve()
    try:
        delivery = read_delivery(root)
        raw_increment = delivery.get('increment')
        complete = args.complete or (isinstance(raw_increment, dict) and raw_increment.get('status') == 'complete')
        increment = validate(root, delivery, complete)
        if complete:
            current = fingerprint(root, delivery)
            verify_review(root, delivery)
            if args.complete:
                passed, evidence = complete_delivery(root, delivery, current)
                message = '本轮声明验收通过；尚未修改 CURRENT' if passed else '本轮验收未通过'
            else:
                evidence = verify_receipt(root, delivery, current)
                passed, message = True, 'complete 收据与当前契约及输入一致'
            print(json.dumps({'status': 'passed' if passed else 'failed', 'message': message,
                              'evidence': evidence, 'limitation': LIMITATION}, ensure_ascii=False))
            return int(not passed)
        print(json.dumps({'status': 'passed', 'increment': increment['id'],
                          'message': '声明与需求覆盖有效；业务未验证；未运行任何验收命令',
                          'limitation': LIMITATION}, ensure_ascii=False))
        return 0
    except (DeliveryError, OSError, ValueError, TypeError, KeyError) as error:
        print(json.dumps({'status': 'failed', 'message': str(error), 'limitation': LIMITATION}, ensure_ascii=False))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
