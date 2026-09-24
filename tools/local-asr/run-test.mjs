import { spawn } from 'node:child_process';
import fs from 'node:fs';

const specPath = process.argv[2];
const outPath = process.argv[3];
const spec = fs.readFileSync(specPath, 'utf8');

const py = 'F:/deepseek/live_auto/.venv-asr/Scripts/python.exe';
const t0 = Date.now();
const child = spawn(py, ['F:/deepseek/live_auto/tools/local-asr/transcribe.py'], {
  stdio: ['pipe', 'pipe', 'pipe'],
});

let out = '';
let err = '';
child.stdout.on('data', (d) => {
  out += d.toString('utf8');
});
child.stderr.on('data', (d) => {
  err += d.toString('utf8');
  // 实时显示下载/进度（镜像下载模型时会有进度条）
  process.stderr.write(d.toString('utf8').slice(-400));
});

child.stdin.write(spec, 'utf8');
child.stdin.end();

child.on('close', (code) => {
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  fs.writeFileSync(outPath, out || '', 'utf8');
  console.log(`  exit=${code}  耗时=${secs}s  stdout=${out.length} 字节  stderr=${err.length} 字节`);
  try {
    const j = JSON.parse(out);
    if (!j.ok) {
      console.log(`  ✗ error: ${j.error}`);
      if (j.trace) console.log(`  trace: ${String(j.trace).slice(0, 500)}`);
    } else {
      console.log(`  ✓ 语言=${j.language}(p=${j.language_probability})  设备=${j.device}/${j.compute_type}`);
      console.log(`    音频 ${j.duration}s  段落 ${j.segments.length} 条  转写耗时 ${j.elapsed_ms}ms`);
      const rt = j.duration > 0 ? (j.elapsed_ms / 1000 / j.duration).toFixed(2) : '?';
      console.log(`    实时率 RTF = ${rt}（越小越快；<0.1 表示比实时快 10 倍以上）`);
      console.log('    前 8 段：');
      for (const s of j.segments.slice(0, 8)) {
        console.log(`      [${s.start.toFixed(2)} - ${s.end.toFixed(2)}] ${s.text}`);
      }
    }
  } catch (e) {
    console.log(`  ✗ 输出不是合法 JSON: ${e.message}`);
    console.log(`  原始输出前 300 字: ${out.slice(0, 300)}`);
  }
});
