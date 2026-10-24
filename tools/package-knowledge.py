"""将独立知识服务、启动脚本与可选离线镜像打包，不读取任何业务资料或密钥。"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import zipfile

ROOT = Path(__file__).resolve().parents[1]
FILES = ['LICENSE', 'packages/knowledge/store.mjs', 'packages/knowledge/server.mjs',
         'docker/Dockerfile.knowledge', 'docker/compose.knowledge.yml',
         'tools/start-knowledge.ps1', 'tools/start-knowledge.sh']


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', required=True)
    parser.add_argument('--image')
    args = parser.parse_args()
    target = Path(args.out).resolve()
    if target.exists():
        raise SystemExit('目标已存在，请使用新目录')
    target.mkdir(parents=True)
    for name in FILES:
        source, dest = ROOT / name, target / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        if source.suffix == '.ps1':
            # Windows PowerShell 5.1 使用 BOM 识别中文脚本。
            dest.write_text(source.read_text(encoding='utf-8-sig'), encoding='utf-8-sig')
        else:
            shutil.copy2(source, dest)
    if args.image:
        (target/'images').mkdir()
        shutil.copy2(args.image, target/'images/spatial-knowledge-20261021.1.tar.gz')
    (target/'启动知识服务.cmd').write_text('@echo off\r\nchcp 65001 >nul\r\npowershell.exe -NoProfile -File "%~dp0tools\\start-knowledge.ps1"\r\nif errorlevel 1 pause\r\n', encoding='utf8')
    (target/'启动知识服务.sh').write_text('#!/bin/sh\nset -eu\nexec sh "$(dirname "$0")/tools/start-knowledge.sh"\n', encoding='utf8')
    manifest = {'product': '3D可视化仓储协同平台 - 可选独立知识服务', 'version': '20261021.1',
                'license': 'MIT，基础镜像组件遵循各自许可证', 'copyright': '2026 零九贰幺',
                'requirements': 'Docker / Docker Compose；带镜像版本无需联网拉取镜像',
                'default_binding': '127.0.0.1:38210', 'retrieval_endpoint': '/retrieval', 'documents_endpoint': '/documents',
                'authentication': '首次启动生成密钥，保存在包目录 .env.knowledge，不随本包预置',
                'retrieval': '中文双字与英文词的全文检索；不包含向量模型或模型权重',
                'scope': '仅知识资料，不包含仓储业务后台、账号、库存或企业文档',
                'usage': '仓储平台的本地模式已内置资料管理；需要单独托管时才启动此包，并通过企业服务模式连接。'}
    (target/'package.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2)+'\n', encoding='utf8')
    hashes = {p.relative_to(target).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
              for p in sorted(target.rglob('*')) if p.is_file()}
    (target/'SHA256.json').write_text(json.dumps(hashes, ensure_ascii=False, indent=2)+'\n', encoding='utf8')
    archive = target.with_suffix('.zip')
    with zipfile.ZipFile(archive, 'w') as z:
        for path in sorted(target.rglob('*')):
            if path.is_file():
                z.write(path, Path(target.name)/path.relative_to(target), compress_type=zipfile.ZIP_STORED if path.suffix=='.gz' else zipfile.ZIP_DEFLATED)
    with zipfile.ZipFile(archive) as z:
        assert z.testzip() is None
        for name, digest in hashes.items():
            assert hashlib.sha256(z.read(target.name+'/'+name)).hexdigest()==digest
    print(json.dumps({'archive': str(archive), 'files':len(hashes)+1, 'bytes':archive.stat().st_size}, ensure_ascii=False))


if __name__ == '__main__':
    main()
