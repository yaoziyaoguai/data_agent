"""合成 SQLite 数据平台：持久提交查证、只读编译、结果分页及取消。"""
import argparse
import hashlib
import hmac
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import os
from pathlib import Path
import sqlite3
import threading
import time

ROOT = Path(__file__).resolve().parents[2]
ALLOWED_TABLES = {'demo_order_detail','raw_order_lines','raw_payments','dim_customers','customer_tags'}
ALLOWED_FUNCTIONS = {'sum','count','min','max','avg','coalesce','nullif','round','strftime','date','datetime','substr','lower','upper','abs','length','row_number','rank','dense_rank','lag','lead','total','ifnull','cast'}
LOCK = threading.Lock()

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
    def __init__(self, directory):
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.business=directory/'business.sqlite'; self.ledger=directory/'submissions.sqlite'
        if not self.business.exists():
            with sqlite3.connect(self.business) as db:
                for name in ('schema.sql','seed.sql','etl.sql'):
                    db.executescript((ROOT/'docs/sources'/name).read_text())
        with sqlite3.connect(self.ledger) as db:
            db.execute('CREATE TABLE IF NOT EXISTS submissions(id TEXT PRIMARY KEY,owner TEXT,fp TEXT,payload TEXT,state TEXT,result TEXT,ready_at REAL,expires_at REAL,cancel TEXT DEFAULT "none")')
            if 'diagnostic' not in {column[1] for column in db.execute('PRAGMA table_info(submissions)')}:
                db.execute('ALTER TABLE submissions ADD COLUMN diagnostic TEXT')
        self.delay=float(os.environ.get('DATA_AGENT_QUERY_DELAY_SECONDS','0.5'))
        self.ttl=float(os.environ.get('DATA_AGENT_RESULT_TTL_SECONDS','86400'))
        self.unknown=os.environ.get('DATA_AGENT_MOCK_SUBMIT_UNKNOWN')=='1'
        self.catalog_file=directory/'catalog.json'
    def catalog(self,payload):
        limit=payload.get('limit',50)
        if type(limit) is not int or not 1<=limit<=50: raise ValueError('invalid_input')
        if self.catalog_file.exists():
            catalog=json.loads(self.catalog_file.read_text())
        else:
            tables=[]
            with sqlite3.connect(f'file:{self.business}?mode=ro',uri=True) as db:
                for name,ddl in db.execute("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"):
                    columns=[{'id':column[1],'name':column[1],'data_type':column[2] or 'TEXT','nullable':not bool(column[3] or column[5]),'comment':''} for column in db.execute('PRAGMA table_info("'+name.replace('"','""')+'")')]
                    node={'id':'build-demo-order-detail','sql':(ROOT/'docs/sources/etl.sql').read_text(),'upstream_ids':['raw_order_lines','raw_payments']} if name=='demo_order_detail' else None
                    tables.append({'id':name,'name':name,'platform_version':'1','comment':'','ddl':ddl,'columns':columns,'node':node})
            catalog={'source_namespace':'synthetic-sqlite','tables':tables}
        snapshot=hashlib.sha256(json.dumps(catalog,sort_keys=True,ensure_ascii=False).encode()).hexdigest()
        if payload.get('snapshot_id') not in (None,snapshot): raise ValueError('version_conflict')
        cursor=payload.get('cursor')
        if cursor is None: offset=0
        elif isinstance(cursor,str) and cursor.startswith(snapshot+':') and cursor[len(snapshot)+1:].isdigit(): offset=int(cursor[len(snapshot)+1:])
        else: raise ValueError('invalid_input')
        tables=catalog['tables']; page=tables[offset:offset+limit]; end=offset+len(page)
        if offset>len(tables): raise ValueError('invalid_input')
        return {'schema_version':1,'source_namespace':catalog['source_namespace'],'snapshot_id':snapshot,'tables':page,'next_cursor':snapshot+':'+str(end) if end<len(tables) else None,'complete':end==len(tables),'authoritative':catalog.get('authoritative',True)}
    def compile(self, payload):
        sql=payload.get('sql',''); params=payload.get('parameters',{})
        if not isinstance(sql,str) or not sql.strip() or len(sql)>24000 or not isinstance(params,dict):
            return {'state':'rejected','reason':'invalid_input'}
        try:
            with sqlite3.connect(f'file:{self.business}?mode=ro',uri=True) as db:
                db.set_authorizer(authorizer)
                db.execute('EXPLAIN '+sql,params).fetchall()
            return {'state':'passed','reason':None,'target_id':'synthetic-sqlite','target_version':'1','dialect':'SQLite','read_only':True}
        except (sqlite3.Error,ValueError,TypeError,OverflowError) as error:
            return {'state':'rejected','reason':'sql_not_supported','diagnostic':sql_diagnostic(error),'target_id':'synthetic-sqlite','target_version':'1','dialect':'SQLite','read_only':True}
    def operate(self,path,payload):
        if path=='/catalog': return self.catalog(payload)
        if path=='/validate': return self.compile(payload)
        qid=payload.get('query_id'); owner=payload.get('owner_id')
        if not isinstance(qid,str) or not isinstance(owner,str): raise ValueError('invalid_input')
        with LOCK,sqlite3.connect(self.ledger) as db:
            db.row_factory=sqlite3.Row
            row=db.execute('SELECT * FROM submissions WHERE id=? AND owner=?',(qid,owner)).fetchone()
            if path=='/submit':
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
                        result={'query_id':qid,'source':'mock','columns':columns,'rows':[[None if cell is None else str(cell) for cell in r] for r in rows],'result_complete':not truncated,'truncated':truncated,'data_freshness':'synthetic_snapshot_2026-02-04','result_ref':qid,'next_cursor':None}
                    state='succeeded'
                except (sqlite3.Error,ValueError,TypeError,OverflowError) as error:
                    state='failed'; diagnostic=sql_diagnostic(error)
                db.execute('UPDATE submissions SET state=?,result=?,diagnostic=? WHERE id=?',(state,json.dumps(result) if result is not None else None,json.dumps(diagnostic) if diagnostic else None,qid))
            if path=='/results':
                if time.time()>row['expires_at']: raise ValueError('result_expired')
                if state!='succeeded': raise ValueError('result_unavailable')
                offset=int(payload.get('cursor') or 0)
                if offset<0: raise ValueError('invalid_input')
                page=result['rows'][offset:offset+100]; end=offset+len(page)
                return {**result,'rows':page,'next_cursor':str(end) if end<len(result['rows']) else None,'result_complete':result['result_complete'] and offset==0 and end==len(result['rows']),'fetched_offset':str(offset)}
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
        except ValueError as e: self.send(409,{'code':str(e) if str(e) in {'invalid_input','sql_not_supported','idempotency_conflict','outcome_unknown','not_available','result_expired','result_unavailable','version_conflict'} else 'invalid_input'})
        except (sqlite3.Error,OSError): self.send(503,{'code':'upstream_failed'})

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--directory',type=Path,required=True);parser.add_argument('--port',type=int,required=True);args=parser.parse_args()
    token=os.environ['DATA_AGENT_INTERNAL_TOKEN']
    if len(token)<32: raise RuntimeError('internal token required')
    server=ThreadingHTTPServer(('127.0.0.1',args.port),Handler);server.token=token;server.platform=Platform(args.directory);server.serve_forever()
