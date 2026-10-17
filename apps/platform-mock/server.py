"""合成 SQLite 数据平台：持久提交查证、只读编译、结果分页及取消。"""
import argparse
from datetime import datetime
import hashlib
import hmac
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import os
from pathlib import Path
import sqlite3
import tempfile
import threading
import time

ROOT = Path(__file__).resolve().parents[2]
ALLOWED_TABLES = {'demo_order_detail','raw_order_lines','raw_payments','dim_customers','customer_tags'}
ALLOWED_FUNCTIONS = {'sum','count','min','max','avg','coalesce','nullif','round','strftime','date','datetime','substr','lower','upper','abs','length','row_number','rank','dense_rank','lag','lead','total','ifnull','cast'}
LOCK = threading.Lock()
BUSINESS_SOURCE_FILES = ('schema.sql', 'seed.sql', 'etl.sql')
SOURCE_FILES = BUSINESS_SOURCE_FILES + ('knowledge-manifest.json',)
# 血缘与来源绑定修订；内容指纹独立保存，不能塞入要求单调整数的接口版本。
PLATFORM_SOURCE_VERSION = '2'
# 旧三文件协议只有这一固定快照；迁移不能借新元信息改写其历史含义。
LEGACY_SNAPSHOT_EXCLUSIVE = '2026-02-04T00:00:00Z'


class SourceVersionConflict(RuntimeError):
    """旧业务库不能与未经核验的新来源混用。"""


def source_documents(directory, names=SOURCE_FILES):
    return {name: (directory / name).read_text(encoding='utf-8') for name in names}


def source_hashes(documents):
    return {name: hashlib.sha256(body.encode()).hexdigest() for name, body in documents.items()}


def source_fingerprint(hashes):
    return hashlib.sha256(json.dumps(hashes, sort_keys=True).encode()).hexdigest()


def database_fingerprint(db):
    # 未标记的旧库只有在结构和全部业务行均与重建结果相同时，才可认领当前来源。
    objects = db.execute("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").fetchall()
    contents = {}
    for kind, name, _, _ in objects:
        if kind == 'table':
            rows = db.execute('SELECT * FROM "' + name.replace('"', '""') + '"').fetchall()
            contents[name] = sorted(json.dumps(row, ensure_ascii=False, default=lambda blob: {'bytes': blob.hex()}) for row in rows)
    return hashlib.sha256(json.dumps({'objects': objects, 'rows': contents}, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def build_business(db, documents):
    for name in ('schema.sql', 'seed.sql'):
        db.executescript(documents[name])
    reads = set()
    def record_read(action, first, _second, _database, _trigger):
        if action == sqlite3.SQLITE_READ:
            reads.add(first)
        return sqlite3.SQLITE_OK
    db.set_authorizer(record_read)
    try:
        db.executescript(documents['etl.sql'])
    finally:
        db.set_authorizer(None)
    return sorted(reads - {'demo_order_detail'})

def sql_diagnostic(error):
    code = getattr(error, 'sqlite_errorname', 'sql_error')
    message = str(error)
    if code == 'SQLITE_INTERRUPT':
        code, message = 'query_timeout', '查询执行超过允许时间，已中止。'
    if isinstance(error, OverflowError):
        code, message = 'parameter_out_of_range', '整数参数超出 SQLite 有符号 64 位范围。'
    return {'code': code, 'message': message[:1000]}

def authorizer(action, first, second, _database, _trigger):
    if action == sqlite3.SQLITE_READ:
        return sqlite3.SQLITE_OK if first in ALLOWED_TABLES else sqlite3.SQLITE_DENY
    if action == sqlite3.SQLITE_FUNCTION:
        return sqlite3.SQLITE_OK if (second or '').lower() in ALLOWED_FUNCTIONS else sqlite3.SQLITE_DENY
    return sqlite3.SQLITE_OK if action in (sqlite3.SQLITE_SELECT, sqlite3.SQLITE_RECURSIVE) else sqlite3.SQLITE_DENY

class Platform:
    def __init__(self, directory, source_directory=None):
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.business=directory/'business.sqlite'; self.ledger=directory/'submissions.sqlite'
        self.source_directory = Path(source_directory or os.environ.get('DATA_AGENT_SYNTHETIC_SOURCE_DIRECTORY', ROOT / 'docs/sources'))
        self.manifest_file = directory / 'source-manifest.json'
        self.source_snapshot = directory / 'source-snapshot'
        self.documents = source_documents(self.source_directory)
        metadata = json.loads(self.documents['knowledge-manifest.json'])
        snapshot_exclusive = metadata.get('snapshot_exclusive')
        if not isinstance(snapshot_exclusive, str):
            raise ValueError('invalid synthetic snapshot')
        snapshot = datetime.strptime(snapshot_exclusive, '%Y-%m-%dT%H:%M:%SZ')
        if snapshot.strftime('%Y-%m-%dT%H:%M:%SZ') != snapshot_exclusive:
            raise ValueError('invalid synthetic snapshot')
        self.snapshot_exclusive = snapshot_exclusive
        self.data_freshness = 'synthetic_snapshot_' + snapshot.strftime('%Y-%m-%d')
        self.hashes = source_hashes(self.documents)
        self.source_fingerprint = source_fingerprint(self.hashes)
        self.platform_version = os.environ.get('DATA_AGENT_SYNTHETIC_PLATFORM_VERSION', PLATFORM_SOURCE_VERSION)
        if (not self.platform_version.isascii() or not self.platform_version.isdigit()
                or self.platform_version.startswith('0') or len(self.platform_version) > 16):
            raise ValueError('invalid synthetic platform version')
        self.prepare_sources()
        with sqlite3.connect(self.ledger) as db:
            db.execute('CREATE TABLE IF NOT EXISTS submissions(id TEXT PRIMARY KEY,owner TEXT,fp TEXT,payload TEXT,state TEXT,result TEXT,ready_at REAL,expires_at REAL,cancel TEXT DEFAULT "none")')
            if 'diagnostic' not in {column[1] for column in db.execute('PRAGMA table_info(submissions)')}:
                db.execute('ALTER TABLE submissions ADD COLUMN diagnostic TEXT')
        self.delay=float(os.environ.get('DATA_AGENT_QUERY_DELAY_SECONDS','0.5'))
        self.ttl=float(os.environ.get('DATA_AGENT_RESULT_TTL_SECONDS','86400'))
        self.unknown=os.environ.get('DATA_AGENT_MOCK_SUBMIT_UNKNOWN')=='1'
        self.catalog_file=directory/'catalog.json'

    def prepare_sources(self):
        if self.manifest_file.exists():
            try:
                manifest = json.loads(self.manifest_file.read_text())
                if set(manifest.get('files', {})) == set(BUSINESS_SOURCE_FILES):
                    # 同源升级只补冻结元信息；独立重建核对，业务库与原结果账本保持原字节。
                    core_hashes = {name: self.hashes[name] for name in BUSINESS_SOURCE_FILES}
                    with sqlite3.connect(f'file:{self.business}?mode=ro', uri=True) as db:
                        actual = database_fingerprint(db)
                    with sqlite3.connect(':memory:') as expected:
                        upstream = build_business(expected, self.documents)
                        expected_fingerprint = database_fingerprint(expected)
                    if (manifest.get('schema_version') != 1
                            or self.snapshot_exclusive != LEGACY_SNAPSHOT_EXCLUSIVE
                            or manifest.get('files') != core_hashes
                            or manifest.get('source_fingerprint') != source_fingerprint(core_hashes)
                            or manifest.get('platform_version') != self.platform_version
                            or source_hashes(source_documents(self.source_snapshot, BUSINESS_SOURCE_FILES)) != core_hashes
                            or manifest.get('business_fingerprint') != actual
                            or actual != expected_fingerprint
                            or manifest.get('etl_upstream_ids') != upstream):
                        raise SourceVersionConflict('旧来源与当前资料不一致；保留旧库及查询账本，使用新的运行目录。')
                    self.upstream_ids = upstream
                    self.persist_source_manifest(actual)
                    return
                snapshot_hashes = source_hashes(source_documents(self.source_snapshot))
                with sqlite3.connect(f'file:{self.business}?mode=ro', uri=True) as db:
                    actual = database_fingerprint(db)
                if (manifest['schema_version'] != 1
                        or manifest['source_fingerprint'] != self.source_fingerprint
                        or manifest['platform_version'] != self.platform_version
                        or manifest['files'] != self.hashes
                        or snapshot_hashes != self.hashes
                        or manifest['business_fingerprint'] != actual
                        or not isinstance(manifest['etl_upstream_ids'], list)
                        or any(not isinstance(value, str) for value in manifest['etl_upstream_ids'])):
                    raise SourceVersionConflict('来源版本或实际业务库已变化；请使用新的运行目录，保留旧目录查询账本和结果。')
                self.upstream_ids = manifest['etl_upstream_ids']
                return
            except (KeyError, ValueError, OSError, sqlite3.Error) as error:
                raise SourceVersionConflict('来源标记或快照无法核验；请使用新的运行目录，保留旧业务库。') from error

        with sqlite3.connect(':memory:') as expected:
            self.upstream_ids = build_business(expected, self.documents)
            expected_fingerprint = database_fingerprint(expected)
        if self.business.exists():
            with sqlite3.connect(f'file:{self.business}?mode=ro', uri=True) as actual:
                if database_fingerprint(actual) != expected_fingerprint:
                    raise SourceVersionConflict('未标记的旧业务库与当前来源不一致；请使用新的运行目录，旧库与查询账本保持原状。')
        else:
            # 失败或中断的建库不发布成可查询的 business.sqlite。
            handle, temporary = tempfile.mkstemp(prefix='business-', suffix='.sqlite', dir=self.business.parent)
            os.close(handle)
            try:
                with sqlite3.connect(temporary) as db:
                    build_business(db, self.documents)
                os.replace(temporary, self.business)
            finally:
                Path(temporary).unlink(missing_ok=True)
        self.persist_source_manifest(expected_fingerprint)

    def persist_source_manifest(self, expected_fingerprint):
        self.source_snapshot.mkdir(mode=0o700, exist_ok=True)
        for name, body in self.documents.items():
            (self.source_snapshot / name).write_text(body, encoding='utf-8')
        manifest = {'schema_version': 1, 'files': self.hashes,
                    'source_fingerprint': self.source_fingerprint,
                    'platform_version': self.platform_version,
                    'business_fingerprint': expected_fingerprint,
                    'etl_upstream_ids': self.upstream_ids}
        temporary = self.manifest_file.with_suffix('.json.tmp')
        temporary.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
        os.replace(temporary, self.manifest_file)

    def require_sources(self):
        try:
            unchanged = source_hashes(source_documents(self.source_directory)) == self.hashes
        except (OSError, UnicodeError):
            unchanged = False
        if not unchanged:
            raise SourceVersionConflict('来源文件已变化；当前实例暂停目录读取和新查询，请使用新的运行目录。旧查询仍可查证和读取。')

    def catalog(self,payload):
        self.require_sources()
        limit=payload.get('limit',50)
        if type(limit) is not int or not 1<=limit<=50: raise ValueError('invalid_input')
        if self.catalog_file.exists():
            catalog=json.loads(self.catalog_file.read_text())
        else:
            tables=[]
            with sqlite3.connect(f'file:{self.business}?mode=ro',uri=True) as db:
                for name,ddl in db.execute("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"):
                    columns=[{'id':column[1],'name':column[1],'data_type':column[2] or 'TEXT','nullable':not bool(column[3] or column[5]),'comment':''} for column in db.execute('PRAGMA table_info("'+name.replace('"','""')+'")')]
                    node={'id':'build-demo-order-detail','sql':self.documents['etl.sql'],'upstream_ids':self.upstream_ids} if name=='demo_order_detail' else None
                    tables.append({'id':name,'name':name,'platform_version':self.platform_version,'maintainer_id':'alice','comment':'','ddl':ddl,'columns':columns,'node':node})
            catalog={'source_namespace':'synthetic-sqlite','tables':tables}
        snapshot=hashlib.sha256(json.dumps({'catalog':catalog,'source_fingerprint':self.source_fingerprint},sort_keys=True,ensure_ascii=False).encode()).hexdigest()
        if payload.get('snapshot_id') not in (None,snapshot): raise ValueError('version_conflict')
        cursor=payload.get('cursor')
        if cursor is None: offset=0
        elif isinstance(cursor,str) and cursor.startswith(snapshot+':') and cursor[len(snapshot)+1:].isdigit(): offset=int(cursor[len(snapshot)+1:])
        else: raise ValueError('invalid_input')
        tables=catalog['tables']; page=tables[offset:offset+limit]; end=offset+len(page)
        if offset>len(tables): raise ValueError('invalid_input')
        return {'schema_version':1,'source_namespace':catalog['source_namespace'],'snapshot_id':snapshot,'tables':page,'next_cursor':snapshot+':'+str(end) if end<len(tables) else None,'complete':end==len(tables),'authoritative':catalog.get('authoritative',True)}
    def compile(self, payload):
        self.require_sources()
        sql=payload.get('sql',''); params=payload.get('parameters',{})
        if not isinstance(sql,str) or not sql.strip() or len(sql)>24000 or not isinstance(params,dict):
            return {'state':'rejected','reason':'invalid_input'}
        try:
            with sqlite3.connect(f'file:{self.business}?mode=ro',uri=True) as db:
                db.set_authorizer(authorizer)
                db.execute('EXPLAIN '+sql,params).fetchall()
            return {'state':'passed','reason':None,'target_id':'synthetic-sqlite','target_version':self.platform_version,'dialect':'SQLite','read_only':True}
        except (sqlite3.Error,ValueError,TypeError,OverflowError) as error:
            return {'state':'rejected','reason':'sql_not_supported','diagnostic':sql_diagnostic(error),'target_id':'synthetic-sqlite','target_version':self.platform_version,'dialect':'SQLite','read_only':True}
    def operate(self,path,payload):
        if path=='/catalog': return self.catalog(payload)
        if path=='/validate': return self.compile(payload)
        qid=payload.get('query_id'); owner=payload.get('owner_id')
        if not isinstance(qid,str) or not isinstance(owner,str): raise ValueError('invalid_input')
        permission_file=self.catalog_file.parent/'permissions.json'
        permissions=json.loads(permission_file.read_text()) if permission_file.exists() else {}
        if path in ('/submit','/results','/result-authority') and owner in permissions.get('denied_query_users',[]): raise ValueError('forbidden')
        with LOCK,sqlite3.connect(self.ledger) as db:
            db.row_factory=sqlite3.Row
            row=db.execute('SELECT * FROM submissions WHERE id=? AND owner=?',(qid,owner)).fetchone()
            if path=='/submit':
                if payload.get('target_id') != 'synthetic-sqlite' or payload.get('target_version') != self.platform_version:
                    raise ValueError('version_conflict')
                report=self.compile(payload)
                if report['state']!='passed': raise ValueError('sql_not_supported')
                fp=hashlib.sha256(json.dumps(payload,sort_keys=True).encode()).hexdigest()
                if row and row['fp']!=fp: raise ValueError('idempotency_conflict')
                if not row:
                    db.execute('INSERT INTO submissions(id,owner,fp,payload,state,ready_at,expires_at) VALUES(?,?,?,?,?,?,?)',(qid,owner,fp,json.dumps(payload),'running',time.time()+self.delay,time.time()+self.ttl))
                    db.commit()
                if self.unknown: raise ValueError('outcome_unknown')
                return {'query_id':qid,'state':'running','result_ref':None,'source':'mock'}
            if not row: raise ValueError('not_available')
            if path=='/result-authority':
                if time.time()>row['expires_at']: raise ValueError('result_expired')
                if row['state']!='succeeded' or not row['result']: raise ValueError('result_unavailable')
                saved=json.loads(row['result'])
                if payload.get('result_ref')!=saved['result_ref']: raise ValueError('result_unavailable')
                return {'query_id':qid,'owner_id':owner,'result_ref':saved['result_ref'],'state':'available','source':'mock',
                        'saved_row_count':len(saved['rows']),'saved_result_complete':not saved['truncated']}
            if path=='/cancel':
                if row['state']=='running': db.execute('UPDATE submissions SET state="cancelled",cancel="completed" WHERE id=?',(qid,))
                diagnostic=json.loads(row['diagnostic']) if row['diagnostic'] else None
                return {'query_id':qid,'state':'cancelled' if row['state']=='running' else row['state'],'cancel_state':'completed' if row['state']=='running' else row['cancel'],'result_ref':qid if row['state']=='succeeded' else None,**({'error':'sql_execution_failed','diagnostic':diagnostic} if diagnostic else {})}
            state=row['state']; result=json.loads(row['result']) if row['result'] else None
            diagnostic=json.loads(row['diagnostic']) if row['diagnostic'] else None
            if state=='running' and time.time()>=row['ready_at']:
                args=json.loads(row['payload']); deadline=time.monotonic()+3
                try:
                    with sqlite3.connect(f'file:{self.business}?mode=ro',uri=True) as source:
                        source.set_authorizer(authorizer)
                        source.set_progress_handler(lambda: int(time.monotonic()>deadline),1000)
                        cursor=source.execute(args['sql'],args.get('parameters',{}))
                        rows=cursor.fetchmany(1001); truncated=len(rows)>1000; rows=rows[:1000]
                        columns=[{'name':col[0],'type':('integer' if any(isinstance(r[i],int) for r in rows) and all(r[i] is None or isinstance(r[i],int) for r in rows) else 'number' if any(isinstance(r[i],(int,float)) for r in rows) and all(r[i] is None or isinstance(r[i],(int,float)) for r in rows) else 'text'),'encoding':'decimal_string'} for i,col in enumerate(cursor.description or [])]
                        result={'query_id':qid,'source':'mock','columns':columns,'rows':[[None if cell is None else str(cell) for cell in r] for r in rows],'result_complete':not truncated,'truncated':truncated,'data_freshness':self.data_freshness,'result_ref':qid,'next_cursor':None,
                                'saved_row_count':len(rows),'saved_result_complete':not truncated}
                    state='succeeded'
                except (sqlite3.Error,ValueError,TypeError,OverflowError) as error:
                    state='failed'; diagnostic=sql_diagnostic(error)
                db.execute('UPDATE submissions SET state=?,result=?,diagnostic=? WHERE id=?',(state,json.dumps(result) if result is not None else None,json.dumps(diagnostic) if diagnostic else None,qid))
            if path=='/results':
                if time.time()>row['expires_at']: raise ValueError('result_expired')
                if state!='succeeded': raise ValueError('result_unavailable')
                cursor=payload.get('cursor')
                if cursor is not None and (not isinstance(cursor,str) or not cursor.isascii() or not cursor.isdigit() or (cursor!='0' and cursor.startswith('0'))): raise ValueError('invalid_input')
                offset=int(cursor or 0)
                if offset>len(result['rows']): raise ValueError('invalid_input')
                page=result['rows'][offset:offset+100]; end=offset+len(page)
                return {**result,'rows':page,'next_cursor':str(end) if end<len(result['rows']) else None,'result_complete':result['result_complete'] and offset==0 and end==len(result['rows']),'fetched_offset':str(offset),
                        'saved_row_count':len(result['rows']),'saved_result_complete':not result['truncated']}
            if path not in ('/lookup','/status'): raise ValueError('not_available')
            return {'query_id':qid,'state':state,'result_ref':qid if state=='succeeded' else None,'source':'mock',**({'error':'sql_execution_failed','diagnostic':diagnostic} if diagnostic else {})}

class Handler(BaseHTTPRequestHandler):
    def log_message(self,*_args): pass
    def send(self,status,value):
        body=json.dumps(value,ensure_ascii=False).encode(); self.send_response(status); self.send_header('Content-Type','application/json'); self.send_header('Content-Length',str(len(body))); self.end_headers(); self.wfile.write(body)
    def do_GET(self):
        self.send(200,{'state':'healthy','source':'mock'}) if self.path=='/health' else self.send(404,{'code':'not_available'})
    def do_POST(self):
        if not hmac.compare_digest(self.headers.get('Authorization',''),'Bearer '+self.server.token): return self.send(401,{'code':'unauthenticated'})
        try:
            size=int(self.headers.get('Content-Length','0'))
            if size<2 or size>131072: raise ValueError('invalid_input')
            data=json.loads(self.rfile.read(size)); result=self.server.platform.operate(self.path,data); self.send(200,result)
        except SourceVersionConflict as error: self.send(409,{'code':'version_conflict','message':str(error)})
        except ValueError as e: self.send(409,{'code':str(e) if str(e) in {'forbidden','invalid_input','sql_not_supported','idempotency_conflict','outcome_unknown','not_available','result_expired','result_unavailable','version_conflict'} else 'invalid_input'})
        except (sqlite3.Error,OSError): self.send(503,{'code':'upstream_failed'})

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--directory',type=Path,required=True);parser.add_argument('--port',type=int,required=True);args=parser.parse_args()
    token=os.environ['DATA_AGENT_INTERNAL_TOKEN']
    if len(token)<32: raise RuntimeError('internal token required')
    server=ThreadingHTTPServer(('127.0.0.1',args.port),Handler);server.token=token;server.platform=Platform(args.directory);server.serve_forever()
