"""收集主JAR及其第一层依赖JAR的许可证据，不提取配置、类文件或完整构建属性。"""
import argparse
import hashlib
import io
import json
import re
from pathlib import Path, PurePosixPath
from zipfile import ZipFile
from xml.etree import ElementTree as ET


def collect(source, output):
    source, output = Path(source), Path(output)
    output.mkdir(parents=True, exist_ok=True)
    records = []

    def inspect(raw, name):
        record = {"archive": name, "sha256": hashlib.sha256(raw).hexdigest(),
                  "coordinates": [], "commitIds": [], "licenses": [], "pomEvidence": []}
        index = len(records)
        with ZipFile(io.BytesIO(raw)) as jar:
            for member in jar.namelist():
                leaf = PurePosixPath(member).name
                if member.endswith('/'):
                    continue
                if leaf == 'pom.xml' and member.startswith('META-INF/maven/'):
                    content = jar.read(member)
                    evidence = {'archivePath': member, 'sha256': hashlib.sha256(content).hexdigest()}
                    try:
                        pom = ET.fromstring(content)
                        # 仅读取本POM的直接声明，不把父POM名称或依赖许可证当作当前组件许可。
                        evidence['declaredLicenses'] = [
                            {key: license.findtext('{*}' + key) for key in ('name', 'url', 'distribution')
                             if license.findtext('{*}' + key)}
                            for license in pom.findall('{*}licenses/{*}license')
                        ]
                        parent = pom.find('{*}parent')
                        if parent is not None:
                            evidence['parent'] = {key: parent.findtext('{*}' + key)
                                                  for key in ('groupId', 'artifactId', 'version')}
                    except ET.ParseError:
                        evidence['error'] = 'POM格式无法解析'
                    record['pomEvidence'].append(evidence)
                if leaf in ('pom.properties', 'git.properties'):
                    props = {}
                    for line in jar.read(member).decode('utf-8', errors='replace').splitlines():
                        if '=' in line and not line.lstrip().startswith('#'):
                            key, value = line.split('=', 1)
                            props[key.strip()] = value.strip()
                    if leaf == 'pom.properties':
                        record['coordinates'].append({k: props[k] for k in ('groupId', 'artifactId', 'version') if k in props})
                    for key in ('git.commit.id', 'git.commit.id.full'):
                        if re.fullmatch(r'[0-9a-fA-F]{40,64}', props.get(key, '')):
                            record['commitIds'].append(props[key])
                if re.match(r'^(LICENSE|LICENCE|NOTICE|COPYING|COPYRIGHT)([._-]|$)', leaf, re.I):
                    content = jar.read(member)
                    # 只使用程序生成的文件名，不把归档路径当作磁盘路径。
                    file = f'{index:03d}-{len(record["licenses"]):03d}.txt'
                    (output / file).write_bytes(content)
                    record['licenses'].append({'archivePath': member, 'file': file,
                                               'sha256': hashlib.sha256(content).hexdigest()})
        record['status'] = ('已有原文待核查' if record['licenses'] else
                            '仅有POM许可声明，原文待补' if any(p.get('declaredLicenses') for p in record['pomEvidence'])
                            else '归档内未发现许可原文或直接POM声明')
        records.append(record)

    raw = source.read_bytes()
    inspect(raw, source.name)
    with ZipFile(io.BytesIO(raw)) as jar:
        for name in jar.namelist():
            if name.endswith('.jar'):
                inspect(jar.read(name), name)
    report = {'scope': '主JAR及第一层内嵌JAR；不覆盖JRE、系统包或镜像其他程序',
              'complianceStatus': '待核查', 'archives': records}
    (output / 'manifest.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('jar')
    parser.add_argument('output')
    args = parser.parse_args()
    report = collect(args.jar, args.output)
    print(json.dumps({'archives': len(report['archives']),
                      'licenseFiles': sum(len(r['licenses']) for r in report['archives']),
                      'archivesWithoutLicenseFiles': sum(not r['licenses'] for r in report['archives']),
                      'declarationsOnly': sum(not r['licenses'] and any(p.get('declaredLicenses') for p in r['pomEvidence']) for r in report['archives']),
                      'complianceStatus': report['complianceStatus']}, ensure_ascii=False))
