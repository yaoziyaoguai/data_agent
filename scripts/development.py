#!/usr/bin/env python3
"""启动本机合成演示；仅使用本项目生成的开发密码与身份。"""
import argparse
import hashlib
import json
import os
import re
from pathlib import Path
import secrets
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[1]
PRIVATE = ROOT / '.local' / 'development'
PORTS = {'api': 8780, 'bridge': 8781, 'web': 5173, 'platform':8790, 'memory':8791}


def memory_configuration(source, database):
    config = json.loads(source.read_text())
    if not re.fullmatch(r'[A-Za-z0-9_]{1,100}', config['collection']):
        raise RuntimeError('Mem0集合前缀无效')
    # 同库重启沿用回执；不同试用数据库不会共享用户索引。
    config['collection'] += '_' + hashlib.sha256(database.encode()).hexdigest()[:16]
    directory = ROOT / '.local/memory/state' / database / config['collection']
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    effective = directory / 'configuration.json'
    effective.write_text(json.dumps(config, ensure_ascii=False, indent=2))
    effective.chmod(0o600)
    return config['collection'], directory, effective


def embedding_configuration(source, database):
    config = json.loads(source.read_text())
    spec = json.loads((ROOT / 'infra/embedding-model.json').read_text())
    if config['embedding_url'] != spec['endpoint']:
        raise RuntimeError('共享向量仅允许配置的百炼端点')
    key_file = (ROOT / config['embedding_key_file']).resolve()
    if not key_file.is_file() or key_file.stat().st_mode & 0o077:
        raise RuntimeError('百炼密钥文件缺失或权限不是0600')
    return {
        'DATA_AGENT_EMBEDDING_URL': spec['endpoint'],
        'DATA_AGENT_EMBEDDING_KEY_FILE': str(key_file),
        'DATA_AGENT_VECTOR_COLLECTION': 'data_agent_shared_qwen1024_' + hashlib.sha256(database.encode()).hexdigest()[:16],
    }


def with_local_proxy_bypass(environment):
    env = dict(environment)
    hosts = [host.strip() for key in ('NO_PROXY', 'no_proxy', 'no_grpc_proxy') for host in env.get(key, '').split(',') if host.strip()]
    env['NO_PROXY'] = env['no_proxy'] = env['no_grpc_proxy'] = ','.join(dict.fromkeys([*hosts, '127.0.0.1', 'localhost', '::1']))
    return env


def read_model_credentials(source):
    if source.stat().st_mode & 0o077:
        raise RuntimeError('.env权限必须为0600')
    values = {}
    for line in source.read_text().splitlines():
        key, separator, value = line.partition('=')
        if separator and key in ('DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'DEEPSEEK_MODEL'):
            values[key] = value.strip()
    return values


def request(url, token=None, body=None):
    headers = {'Content-Type': 'application/json'}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, headers=headers)
    # 本地调用不能经企业代理转发。
    return urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req, timeout=2)


def wait_health(url, processes, service, runtime_dir, timeout=25):
    started = time.monotonic()
    log = runtime_dir / (service + '.log')
    print(f'startup service={service} stage=waiting log={log}', flush=True)
    while time.monotonic() - started < timeout:
        for name, process in processes:
            code = process.poll()
            if code is not None:
                elapsed = time.monotonic() - started
                raise RuntimeError(f'startup service={name} stage=exited code={code} elapsed={elapsed:.2f}s log={runtime_dir / (name + ".log")}')
        try:
            with request(url) as response:
                if response.status == 200:
                    print(f'startup service={service} stage=ready elapsed={time.monotonic()-started:.2f}s log={log}', flush=True)
                    return
        except (OSError, urllib.error.URLError):
            pass
        time.sleep(.1)
    raise RuntimeError(f'startup service={service} stage=timeout elapsed={time.monotonic()-started:.2f}s log={log}')


def available_ports(offset):
    ports = {name: port + offset for name, port in PORTS.items()}
    if any(port > 65535 or port < 1024 for port in ports.values()):
        raise RuntimeError('端口偏移超出允许范围')
    for port in ports.values():
        with socket.socket() as probe:
            # 与应用监听器一致，允许重启时复用已关闭连接的 TIME_WAIT 端口；仍拒绝活跃监听。
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            probe.bind(('127.0.0.1', port))
    return ports


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', choices=('mock','deepseek','protocol-test'), default='mock', help='mock不付费；deepseek沿用已批准小样的原数据库与试验预算')
    parser.add_argument('--model-profile', type=Path, help='读取已获授权的持久模型试验配置；不重置其ID、数据库或额度')
    parser.add_argument('--model-url', help='仅protocol-test接受127.0.0.1回环模型；不读取官方密钥')
    parser.add_argument('--memory',choices=('builtin','mem0'),help='真实DeepSeek默认Mem0；mock默认builtin且不付费')
    parser.add_argument('--memory-configuration',type=Path,default=ROOT/'.local/memory/configuration.json')
    parser.add_argument('--retrieval',choices=('hybrid','lexical'),help='真实DeepSeek默认百炼Qwen和Milvus；mock默认词法且不付费')
    parser.add_argument('--embedding-profile',type=Path,default=ROOT/'.local/embedding/profile.json',help='共享索引与页面检索的固定维护预算')
    parser.add_argument('--embedding-configuration',type=Path,default=ROOT/'.local/memory/configuration.json',help='复用百炼endpoint和密钥路径，不启动Mem0服务')
    parser.add_argument('--check', action='store_true', help='启动、检查身份和页面，然后关闭自己启动的进程')
    parser.add_argument('--port-offset', type=int, default=0, help='本地验证使用独立端口，不影响正在运行的工作台')
    parser.add_argument('--runtime-dir', type=Path, help='使用.local下独立的运行目录保存本次开发身份和平台账本')
    args = parser.parse_args()
    retrieval_mode=args.retrieval or ("hybrid" if args.model=="deepseek" else "lexical")
    if retrieval_mode=="hybrid" and args.model!="deepseek":
        raise RuntimeError("真实向量需要显式deepseek模型配置和持久预算；mock请用lexical")
    memory_provider=args.memory or ("mem0" if args.model=="deepseek" else "builtin")
    if memory_provider=="mem0" and args.model!="deepseek":
        raise RuntimeError("Mem0默认使用真实服务，必须显式选择deepseek模型")
    try:
        ports = available_ports(args.port_offset)
    except OSError:
        if not args.check or args.port_offset:
            raise
        for offset in range(10000, 40000, 100):
            try:
                ports = available_ports(offset)
                break
            except OSError:
                continue
        else:
            raise RuntimeError('没有可用于启动验证的独立端口')
    private = (args.runtime_dir or (ROOT / '.local/checks' / ('startup-' + secrets.token_hex(8)) if args.check else PRIVATE)).resolve()
    if not private.is_relative_to(ROOT / '.local'):
        raise RuntimeError('运行目录必须位于本项目.local下')
    marker = ROOT / '.local' / 'infra' / 'prepared.json'
    if not marker.is_file():
        raise RuntimeError('先运行 make infra-up，准备本项目的开发数据库')
    password = (ROOT / '.local' / 'infra' / 'mysql-app-password').read_text().strip()
    private.mkdir(parents=True, exist_ok=True, mode=0o700)
    credentials = private / 'identities.json'
    if not credentials.exists():
        with credentials.open('x') as output:
            os.chmod(credentials, 0o600)
            json.dump({'alice': secrets.token_hex(32), 'bob': secrets.token_hex(32), 'internal': secrets.token_hex(32)}, output)
    identities = json.loads(credentials.read_text())
    if set(identities) != {'alice', 'bob', 'internal'} or any(len(v) != 64 for v in identities.values()):
        raise RuntimeError('本项目开发身份格式不兼容，请核对 identities.json')
    database='data_agent'
    model_profile=None
    model_credentials={}
    if args.model in ('deepseek','protocol-test'):
        trial=json.loads((args.model_profile or (ROOT / '.local/model-trial/configuration.json')).read_text())
        database=trial['database']
        if not re.fullmatch(r'data_agent_trial_[a-f0-9]+',database):
            raise RuntimeError('真实小样数据库配置无效')
        model_profile=trial['profile']
        if args.model == 'protocol-test':
            from urllib.parse import urlparse
            endpoint=urlparse(args.model_url or '')
            if endpoint.scheme != 'http' or endpoint.hostname != '127.0.0.1' or not endpoint.port or endpoint.path not in ('','/') or endpoint.username or endpoint.password or endpoint.query or endpoint.fragment:
                raise RuntimeError('协议验证仅允许本机回环端点')
            model_credentials={'DEEPSEEK_API_KEY':'synthetic-protocol-key','DEEPSEEK_BASE_URL':args.model_url.rstrip('/'),'DEEPSEEK_MODEL':model_profile['model_id']}
        else:
            model_credentials=read_model_credentials(ROOT / '.env')
            if not model_credentials.get('DEEPSEEK_API_KEY') or model_credentials.get('DEEPSEEK_BASE_URL') != 'https://api.deepseek.com' or model_credentials.get('DEEPSEEK_MODEL') not in ('deepseek-flash', 'deepseek-v4-pro'):
                raise RuntimeError('官方模型配置无效')
            # 持久试验配置是本次模型选择的依据；.env仅保留本地默认值。
            model_credentials['DEEPSEEK_MODEL'] = model_profile['model_id']
    env = dict(os.environ, PI_OFFLINE='1', DATA_AGENT_MODE='development', DATA_AGENT_TOOLSET='data', DATA_AGENT_PLATFORM_URL='http://127.0.0.1:'+str(ports['platform']),
               DATA_AGENT_DATABASE_URL='mysql://data_agent:' + quote(password, safe='') + '@127.0.0.1:13306/'+database,
               DATA_AGENT_SEMANTIC_SUPER_MAINTAINERS=os.environ.get('DATA_AGENT_SEMANTIC_SUPER_MAINTAINERS', json.dumps({'demo': ['alice']})),
               DATA_AGENT_DEV_IDENTITIES=json.dumps({identities[u]: u for u in ('alice', 'bob')}),
               DATA_AGENT_INTERNAL_TOKEN=identities['internal'], DATA_AGENT_API_PORT=str(ports['api']),
               DATA_AGENT_BRIDGE_PORT=str(ports['bridge']), DATA_AGENT_API_URL='http://127.0.0.1:' + str(ports['api']),
               DATA_AGENT_BRIDGE_URL='http://127.0.0.1:' + str(ports['bridge']))
    env = with_local_proxy_bypass(env)
    # 故障注入只属于测试命令，不随日常演示环境继承。
    for option in ('DATA_AGENT_FAULT', 'DATA_AGENT_MOCK_DELAY_MS', 'DATA_AGENT_LEASE_MS', 'DATA_AGENT_MODEL_PROFILE', 'DATA_AGENT_PROVIDER_TEST', 'DATA_AGENT_MODEL_TIMEOUT_MS', 'DATA_AGENT_PREFILL_TIMEOUT_MS', 'DATA_AGENT_PREFILL_PROFILE', 'DATA_AGENT_PREFILL_URL', 'DATA_AGENT_PREFILL_TEST', 'DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'DEEPSEEK_MODEL'):
        env.pop(option, None)
    for option in ('DATA_AGENT_EMBEDDING_URL','DATA_AGENT_EMBEDDING_KEY_FILE','DATA_AGENT_EMBEDDING_PROFILE','DATA_AGENT_EMBEDDING_TEST','DATA_AGENT_VECTOR_URL','DATA_AGENT_VECTOR_COLLECTION','DATA_AGENT_VECTOR_TOKEN_FILE','DATA_AGENT_MEMORY_URL','DATA_AGENT_MEMORY_TEST','DATA_AGENT_MEMORY_INDEX_TARGET'):
        env.pop(option,None)
    if retrieval_mode=='hybrid':
        env.update(embedding_configuration(args.embedding_configuration,database))
        env['DATA_AGENT_EMBEDDING_PROFILE']=args.embedding_profile.read_text()
        token_file=ROOT/'.local/infra/milvus-root-password'
        if not token_file.is_file():
            raise RuntimeError('先运行 make infra-up，准备本地Milvus')
        env.update(DATA_AGENT_VECTOR_URL='http://127.0.0.1:19531',DATA_AGENT_VECTOR_TOKEN_FILE=str(token_file))
    if model_profile:
        env['DATA_AGENT_MODEL_PROFILE']=json.dumps(model_profile)
    if model_profile:
        env['DATA_AGENT_TOOLSET']=model_profile.get('toolset','task')
        if model_profile.get('toolset') == 'data':
            env['DATA_AGENT_PREFILL_PROFILE']=json.dumps(model_profile)
            env['DATA_AGENT_PREFILL_URL']=model_credentials['DEEPSEEK_BASE_URL']+'/chat/completions'
    if args.model == 'protocol-test':
        env['DATA_AGENT_PROVIDER_TEST']='1'
        env['DATA_AGENT_PREFILL_TEST']='1'
    if memory_provider=='mem0':
        if not args.memory_configuration.is_file() or not (ROOT/'.local/memory-venv/bin/python').is_file():
            raise RuntimeError('先运行make setup-memory，并配置.local/memory/configuration.json')
        env['DATA_AGENT_MEMORY_URL']='http://127.0.0.1:'+str(ports['memory'])
        target, memory_directory, effective_memory_configuration = memory_configuration(args.memory_configuration, database)
        env['DATA_AGENT_MEMORY_INDEX_TARGET'] = target
    commands = [
        ('platform', ['python3','apps/platform-mock/server.py','--directory',str(private/'platform'),'--port',str(ports['platform'])]),
        ('api', [str(ROOT / 'target/debug/data-agent-api')]),
        ('bridge', ['node', 'apps/agent/server.ts']),
        ('worker', [str(ROOT / 'target/debug/data-agent-worker')]),
        ('web', ['node', 'node_modules/vite/bin/vite.js', 'apps/web', '--config', 'apps/web/vite.config.ts', '--port', str(ports['web'])]),
    ]
    if memory_provider=='mem0':
        commands.insert(2,('memory',[str(ROOT/'.local/memory-venv/bin/python'),'apps/memory/server.py','--configuration',str(effective_memory_configuration),'--directory',str(memory_directory),'--port',str(ports['memory'])]))
    processes, logs = [], []
    def interrupt(_signal, _frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, interrupt)
    try:
        for name, argv in commands:
            log = (private / (name + '.log')).open('w')
            logs.append(log)
            print(f'startup service={name} stage=spawn log={log.name}', flush=True)
            processes.append((name, subprocess.Popen(argv, cwd=ROOT, env={**env,**(model_credentials if name in ('bridge','worker','memory') else {})}, stdout=log, stderr=log)))
            if name in ('api', 'bridge','platform','memory'):
                wait_health('http://127.0.0.1:' + str(ports[name]) + '/health', processes, name, private)
        wait_health('http://127.0.0.1:' + str(ports['web']), processes, 'web', private)
        model_label = ('DeepSeek V4 Pro' if model_profile['model_id'] == 'deepseek-v4-pro' else 'DeepSeek Flash') if model_profile else '本地模拟模型'
        for user in ('alice', 'bob'):
            with request(env['DATA_AGENT_API_URL'] + '/session', identities[user]) as response:
                assert json.load(response) == {'user_id': user,'model_label':model_label}
        print('工作台：http://127.0.0.1:' + str(ports['web']) + '/', flush=True)
        print('演示登录凭据：' + str(credentials.relative_to(ROOT)) + ' 中的 alice 或 bob 值；此文件不进入 Git。', flush=True)
        if args.check:
            print('本地启动、页面与两个开发身份检查通过。', flush=True)
            return
        print('Ctrl+C 关闭本次启动的应用进程；数据库和会话保留。', flush=True)
        while True:
            if any(p.poll() is not None for _, p in processes):
                raise RuntimeError('应用进程退出，请检查开发日志')
            time.sleep(.3)
    finally:
        for _, process in reversed(processes):
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
        for log in logs:
            log.close()


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        pass
    except Exception as error:
        # 不打印可能包含密码的连接地址或环境。
        print('开发启动失败：' + (str(error) if isinstance(error, (RuntimeError, OSError)) else type(error).__name__), file=sys.stderr)
        sys.exit(1)
