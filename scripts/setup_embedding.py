"""准备锁定的运行库与模型；固定revision、文件大小和SHA-256。"""
import hashlib
import json
import io
import lzma
import os
from pathlib import Path
import subprocess
import tarfile
import tomllib
import urllib.request

ROOT = Path(__file__).resolve().parents[1]

def main():
    target = subprocess.check_output([str(Path.home()/'.cargo/bin/rustc'), '-vV'], text=True)
    host = next(line.split(': ', 1)[1] for line in target.splitlines() if line.startswith('host: '))
    output = Path(os.environ.get('ORT_LIB_PATH', ROOT/'.local/embedding-runtime'))
    if (output/'libonnxruntime.a').is_file() or (output/'onnxruntime.lib').is_file():
        print('本地 Embedding 运行库已就绪')
        setup_model()
        return
    lock = tomllib.loads((ROOT/'Cargo.lock').read_text())
    version = next(p['version'] for p in lock['package'] if p['name']=='ort-sys')
    registry = Path(os.environ.get('CARGO_HOME', Path.home()/'.cargo'))/'registry/src'
    manifests = list(registry.glob(f'*/ort-sys-{version}/build/download/dist.tsv'))
    if len(manifests)!=1:
        raise RuntimeError('先运行 cargo fetch --locked，获取锁定版本的运行库分发清单')
    rows = [line.split('\t') for line in manifests[0].read_text().splitlines()[1:] if line.startswith(host+'\t')]
    if not rows:
        raise RuntimeError('当前主机没有预编译分发；请配置 ORT_LIB_PATH 指向兼容运行库')
    _, features, url, expected = min(rows, key=lambda r: (r[1].count(','), len(r[1])))
    if not url.startswith('https://cdn.pyke.io/'):
        raise RuntimeError('分发地址不属于锁定依赖的官方CDN')
    cached=ROOT/'.local/checks/ort-prebuilt-runtime.tar.lzma2'
    if cached.is_file() and hashlib.sha256(cached.read_bytes()).hexdigest()==expected:
        data=cached.read_bytes()
    else:
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(url,timeout=45) as response:
            data=response.read(100_000_001)
    if len(data)>100_000_000 or hashlib.sha256(data).hexdigest()!=expected:
        raise RuntimeError('运行库归档大小或SHA-256不匹配')
    decoder=lzma.LZMADecompressor(format=lzma.FORMAT_RAW,filters=[{'id':lzma.FILTER_LZMA2,'dict_size':1<<26}])
    unpacked=decoder.decompress(data,max_length=250_000_001)
    if len(unpacked)>250_000_000 or not decoder.eof:
        raise RuntimeError('运行库归档解压不完整或超过限额')
    output.mkdir(parents=True,exist_ok=True)
    with tarfile.open(fileobj=io.BytesIO(unpacked)) as archive:
        archive.extractall(output,filter='data')
    print(f'本地 Embedding 运行库已校验：{host}，分发特性 {features}')
    setup_model()

def setup_model():
    manifest=json.loads((ROOT/'infra/embedding-model.json').read_text())
    repository,revision=manifest['repository'],manifest['revision']
    output=ROOT/'.local/embedding-model'
    for name,metadata in manifest['files'].items():
        destination=output/name
        def valid(path):
            return path.is_file() and path.stat().st_size==metadata['size'] and hashlib.file_digest(path.open('rb'),'sha256').hexdigest()==metadata['sha256']
        if valid(destination):
            continue
        destination.parent.mkdir(parents=True,exist_ok=True)
        cached=ROOT/'.local/embedding-cache'/('models--'+repository.replace('/','--'))/'snapshots'/revision/name
        if valid(cached):
            import shutil
            shutil.copyfile(cached,destination)
        else:
            url=f'https://huggingface.co/{repository}/resolve/{revision}/{name}'
            temporary=destination.with_suffix(destination.suffix+'.download')
            with urllib.request.urlopen(url,timeout=60) as response, temporary.open('wb') as target:
                total=0
                while chunk:=response.read(1024*1024):
                    total+=len(chunk)
                    if total>metadata['size']: raise RuntimeError('模型文件超过锁定大小')
                    target.write(chunk)
            if not valid(temporary): raise RuntimeError('模型文件SHA-256不匹配')
            temporary.replace(destination)
        if not valid(destination): raise RuntimeError('本地模型文件SHA-256不匹配')
    print('本地 Embedding 模型已校验：'+revision)
    cache=output/'hf-cache'/('models--'+repository.replace('/','--'))
    (cache/'refs').mkdir(parents=True,exist_ok=True)
    (cache/'refs/main').write_text(revision)
    for name in manifest['files']:
        link=cache/'snapshots'/revision/name
        link.parent.mkdir(parents=True,exist_ok=True)
        if not link.exists(): link.symlink_to(os.path.relpath(output/name,link.parent))

if __name__=='__main__':
    main()
