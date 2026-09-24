import { execFileSync } from 'node:child_process';
import path from 'node:path';

const FF = 'C:/Users/demo/tools/ffmpeg/bin/ffmpeg.exe';
const SRC = 'F:/deepseek/live_auto/data/local-asr-test/sample-300s.flv';
const OUT = 'F:/deepseek/live_auto/data/local-asr-test';

// 需要裁定的争议点（时间取自云端 SRT 的时间轴）
const cases: Array<{ t: number; dur: number; label: string; cloud: string; local: string }> = [
  { t: 2.6, dur: 4.4, label: 'you-vs-again', cloud: '特别的日子有灿烂的笑容', local: '特别的日子又灿烂的笑容' },
  { t: 25.4, dur: 7.5, label: 'meitian-vs-meidian', cloud: '生日快乐！每一天都精彩', local: '每一点都精彩' },
  { t: 41.8, dur: 4.5, label: 'wangwangci', cloud: '哎，忘忘词了', local: '诶 忘词了 等等等等' },
  { t: 55.2, dur: 5.5, label: 'zhufu-repeat', cloud: '祝你幸福永远幸福永远', local: '祝你幸福永远' },
  { t: 63.3, dur: 4.5, label: 'zhege-ci', cloud: '哎呀，把这个词儿记差了', local: '把这个词记差了' },
  { t: 66.2, dur: 3.5, label: 'duibuqi', cloud: '对不起啊。有点放不开', local: '有点放不开' },
];

console.log('=== 提取争议点音频（每段单独成文件，便于人工听辨）===');
for (const c of cases) {
  const out = path.join(OUT, `diff-${c.label}.wav`);
  execFileSync(FF, ['-hide_banner', '-loglevel', 'error', '-ss', String(c.t), '-t', String(c.dur), '-i', SRC, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-y', out]);
  console.log(`  ${c.label}.wav  [${c.t}s +${c.dur}s]`);
  console.log(`      云端说: ${c.cloud}`);
  console.log(`      本地说: ${c.local}`);
}

// 额外：把云端与本地分歧最大的区段做一个拼接对照音频（连续播放便于比对）
console.log('\n=== 音频文件已就绪 ===');
console.log('  位置: data/local-asr-test/diff-*.wav');
console.log('  这些是 16kHz 单声道 wav，可直接用播放器逐个听，判断哪边听对了。');
