"""本地输入识别：只输出文字，不连接库存数据库或云端服务。"""
import csv
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import wave
from pathlib import Path


def run(args):
    return subprocess.run(args, check=True, capture_output=True, timeout=35).stdout


def speech(source, folder):
    from vosk import Model, KaldiRecognizer, SetLogLevel
    SetLogLevel(-1)
    target = str(Path(folder) / 'speech.wav')
    run(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-i', source, '-t', '61', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', target])
    with wave.open(target, 'rb') as audio:
        duration = audio.getnframes() / audio.getframerate()
        if duration > 60 or duration < 0.2:
            raise ValueError('请选择0.2至60秒的录音')
        recognizer = KaldiRecognizer(Model(os.environ['SPATIAL_INPUT_MODEL']), 16000)
        recognizer.SetWords(True)
        parts = []
        while data := audio.readframes(4000):
            if recognizer.AcceptWaveform(data):
                parts.append(json.loads(recognizer.Result()))
        parts.append(json.loads(recognizer.FinalResult()))
    words = [word for part in parts for word in part.get('result', [])]
    return {'text': ' '.join(part.get('text', '') for part in parts).strip(), 'confidence': sum(word['conf'] for word in words) / len(words) if words else 0, 'duration': round(duration, 2)}


def photo(source, folder):
    from PIL import Image, ImageOps
    Image.MAX_IMAGE_PIXELS = 20000000
    target = str(Path(folder) / 'label.png')
    with Image.open(source) as image:
        if image.width * image.height > 20000000:
            raise ValueError('图片尺寸过大，请拍摄单张货品标签')
        image = ImageOps.exif_transpose(image).convert('RGB')
        scale = min(2, 2400 / max(image.size))
        image = ImageOps.autocontrast(ImageOps.grayscale(image.resize((max(1, round(image.width * scale)), max(1, round(image.height * scale))))))
        image.save(target)
    tsv = run(['tesseract', target, 'stdout', '-l', 'chi_sim+eng', '--psm', '6', 'tsv']).decode('utf-8')
    lines = {}
    confidences = []
    for row in csv.DictReader(io.StringIO(tsv), delimiter='\t'):
        if row.get('level') != '5' or not row.get('text', '').strip():
            continue
        key = tuple(row[k] for k in ['page_num', 'block_num', 'par_num', 'line_num'])
        lines.setdefault(key, []).append({'text': row['text'], 'left': int(row['left']), 'top': int(row['top']), 'width': int(row['width']), 'height': int(row['height']), 'confidence': max(0, float(row['conf']) / 100)})
        if float(row['conf']) >= 0:
            confidences.append(float(row['conf']) / 100)
    output = [{'text': ' '.join(word['text'] for word in words), 'words': words} for words in lines.values()]
    return {'text': '\n'.join(line['text'] for line in output), 'lines': output, 'confidence': sum(confidences) / len(confidences) if confidences else 0}


def main():
    kind = sys.argv[1]
    if kind == 'status':
        import vosk
        from PIL import Image
        return {'speech': bool(shutil.which('ffmpeg') and Path(os.environ.get('SPATIAL_INPUT_MODEL', '')).joinpath('am/final.mdl').is_file()), 'photo': bool(shutil.which('tesseract')), 'provider': 'Vosk / Tesseract · 本地识别'}
    with tempfile.TemporaryDirectory(prefix='warehouse-recognize-') as folder:
        if kind == 'speech':
            return speech(sys.argv[2], folder)
        if kind == 'photo':
            return photo(sys.argv[2], folder)
        raise ValueError('不支持的识别类型')


try:
    print(json.dumps(main(), ensure_ascii=False))
except Exception as error:
    # 不将上传内容、文件路径或原始解码日志返回页面。
    message = str(error) if isinstance(error, ValueError) else '无法识别此文件，请重新录音或拍摄清晰标签'
    print(json.dumps({'error': message}, ensure_ascii=False))
    sys.exit(1)
