"""生成公开源码包：只取明确的代码目录，不包含运行环境或业务资料。"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import zipfile

ROOT = Path(__file__).resolve().parents[1]
TOP = ['LICENSE', 'README.md', '.gitignore', '.gitattributes', '.dockerignore',
       'package.json', 'package-lock.json', 'apps', 'packages', 'db', 'docker',
       'third-party', 'tools', 'examples']
DOCS = ['docs/openapi.yaml', 'docs/supos-integration.md', 'docs/external-editors.md']
SKIP = {'node_modules', 'out', '__pycache__', '.git', 'data', 'uploads', 'backups', 'certs'}


def accepted(path):
    rel = path.relative_to(ROOT)
    return (not any(part in SKIP for part in rel.parts)
            and not path.is_symlink()
            and not path.name.startswith('.env')
            and path.suffix.lower() not in {'.log', '.err', '.db', '.sqlite', '.pem', '.key', '.pyc', '.mp4', '.wav', '.mp3'}
            and str(rel).replace('\\', '/') != 'tools/package-review-source.ps1')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', required=True)
    parser.add_argument('--version', default='oa2026-20261020.1')
    args = parser.parse_args()
    out = Path(args.out).resolve()
    if out.exists():
        raise SystemExit('输出目录已存在，请使用新目录，避免覆盖已有资料')
    if out == ROOT or ROOT in out.parents and out.parts[len(ROOT.parts)] in TOP:
        raise SystemExit('输出目录不能位于源码目录内部')
    out.mkdir(parents=True)
    source = out / 'spatial-inventory'
    files = set()
    for name in TOP + DOCS:
        p = ROOT / name
        if not p.exists():
            raise SystemExit('缺少源码文件：' + name)
        files.update(f for f in ([p] if p.is_file() else p.rglob('*')) if f.is_file() and accepted(f))
    hashes = {}
    for path in sorted(files):
        rel = path.relative_to(ROOT)
        target = source / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, target)
        hashes[rel.as_posix()] = hashlib.sha256(target.read_bytes()).hexdigest()
    manifest = {'version': args.version, 'license': 'MIT', 'copyright': '2026 零九贰幺',
                'scope': '公开源码；不包含账号、业务数据、模型权重及历史参赛资料', 'files': hashes}
    (source / 'source-manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf8')
    archive = out / ('spatial-inventory-' + args.version + '-source.zip')
    with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for f in sorted(source.rglob('*')):
            if f.is_file():
                z.write(f, f.relative_to(out).as_posix())
    with zipfile.ZipFile(archive) as z:
        assert z.testzip() is None
        for rel, digest in hashes.items():
            assert hashlib.sha256(z.read('spatial-inventory/' + rel)).hexdigest() == digest
    result = {'archive': archive.name, 'sha256': hashlib.sha256(archive.read_bytes()).hexdigest(),
              'source_files': len(hashes), 'version': args.version, 'license': 'MIT'}
    (out / 'release.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf8')
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
