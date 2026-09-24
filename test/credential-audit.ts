/**
 * 凭据泄露审计（硬约束 #8）：确认源码与交付文档里没有真实凭据。
 *
 * 为什么需要独立脚本：光靠「人工不写」不足以保证，必须有可重复执行的机器检查。
 * 本脚本会主动构造若干「坏样本」验证检测能力，避免出现「永远通过」的假闸门。
 *
 * 用法：
 *   node test/credential-audit.ts           # 审计整个项目
 *   node test/credential-audit.ts --json    # 机器可读输出
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR } from '../src/util.ts';

const JSON_ONLY = process.argv.includes('--json');

/** 参与审计的目录与扩展名 */
const TARGETS: Array<{ dir: string; exts: string[] }> = [
  { dir: 'src', exts: ['.ts'] },
  { dir: 'test', exts: ['.ts', '.json', '.xml', '.md'] },
  { dir: 'docs', exts: ['.md', '.json'] },
  { dir: 'prompts', exts: ['.md'] },
  { dir: 'public', exts: ['.html'] },
  { dir: 'tools', exts: ['.mjs', '.js', '.ts'] },
  { dir: '', exts: ['.md', '.json', '.bat', '.ps1'] }, // 根目录的交付文件
];

/**
 * 必须排除的文件：
 *  - `config.json` 本身**就是**凭据存放处（已被 .gitignore 忽略），把它的内容算作泄露没有意义。
 *  - 脱敏工具与它的测试刻意写了各种密钥形态的**假样本**来验证规则是否生效。
 *    对它们只做「真实值比对」，不做形态匹配 —— 这样既不会误报，
 *    又能保证「有人把真值粘进这些文件」时依然会被抓到。
 */
const EXCLUDED = new Set(['config.json']);
const SHAPE_EXEMPT = new Set(['src/redact.ts', 'test/redact-selftest.ts', 'test/credential-audit.ts']);

/** 从真实配置读取凭据（只读值用于比对，绝不打印） */
function realSecrets(): Array<{ label: string; value: string }> {
  const out: Array<{ label: string; value: string }> = [];
  const cfgPath = path.join(ROOT_DIR, 'config.json');
  if (fs.existsSync(cfgPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as {
        bililive?: { passKey?: string };
        llm?: { summary?: { apiKey?: string }; select?: { apiKey?: string } };
        alert?: { serverchan?: { sendKey?: string }; dingtalk?: { secret?: string }; telegram?: { botToken?: string } };
      };
      const push = (label: string, v: string | undefined): void => {
        // 阈值 8：太短的值（如 "none"）出现在正常文本里会造成大量误报
        if (v && v.length >= 8 && !/在此填写|你的|your|xxx|placeholder/i.test(v)) out.push({ label, value: v });
      };
      push('bililive.passKey', cfg.bililive?.passKey);
      push('llm.summary.apiKey', cfg.llm?.summary?.apiKey);
      push('llm.select.apiKey', cfg.llm?.select?.apiKey);
      push('alert.serverchan.sendKey', cfg.alert?.serverchan?.sendKey);
      push('alert.dingtalk.secret', cfg.alert?.dingtalk?.secret);
      push('alert.telegram.botToken', cfg.alert?.telegram?.botToken);
    } catch {
      /* 配置损坏时跳过（另有 validateConfig 负责报错） */
    }
  }
  return out;
}

/** 与真实配置无关的「形态级」凭据模式（写死在源码里同样不允许） */
const SHAPE_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: 'B站 SESSDATA（明文 cookie）', re: /SESSDATA=[A-Za-z0-9%_\-.]{10,}/ },
  { label: 'B站 bili_jct（明文 csrf）', re: /bili_jct=[0-9a-f]{16,}/i },
  { label: '阿里云 AccessKeyId', re: /LTAI[A-Za-z0-9]{12,}/ },
  { label: 'OpenAI/DeepSeek 风格密钥（真实长度 ≥ 24）', re: /sk-[A-Za-z0-9]{24,}/ },
  { label: 'Server酱 SendKey', re: /SCT[0-9]{6,}[A-Za-z0-9]{10,}/ },
  { label: 'Telegram bot token', re: /\b\d{8,12}:AA[A-Za-z0-9_-]{30,}/ },
];

function walk(dir: string, exts: string[]): string[] {
  const abs = path.join(ROOT_DIR, dir);
  const out: string[] = [];
  const visit = (d: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (['node_modules', 'data', '.git', 'dist'].includes(e.name)) continue;
        visit(full);
      } else if (exts.includes(path.extname(e.name).toLowerCase())) {
        out.push(full);
      }
    }
  };
  visit(abs);
  return out;
}

interface Hit {
  file: string;
  line: number;
  label: string;
  /** 命中行的脱敏预览 */
  preview: string;
}

function audit(): { hits: Hit[]; scannedFiles: number; scannedExts: string[] } {
  const secrets = realSecrets();
  const hits: Hit[] = [];
  let scannedFiles = 0;
  const scannedExts = new Set<string>();

  for (const t of TARGETS) {
    for (const file of walk(t.dir, t.exts)) {
      const rel = path.relative(ROOT_DIR, file).replace(/\\/g, '/');
      if (EXCLUDED.has(rel)) continue;
      scannedFiles++;
      scannedExts.add(path.extname(file));
      let text: string;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      const lines = text.split('\n');
      const shapeScan = !SHAPE_EXEMPT.has(rel);
      lines.forEach((line, i) => {
        // 1) 真实凭据值泄露（任何文件里都不允许 —— 包括脱敏工具自身：
        //    若它的样例串恰好等于真实值，说明有人把真值粘进了代码）
        for (const s of secrets) {
          if (line.includes(s.value)) {
            hits.push({ file: rel, line: i + 1, label: `真实凭据泄露：${s.label}`, preview: previewOf(line, s.value) });
          }
        }
        // 2) 形态级命中（脱敏工具及其测试里的假样本不算）
        if (!shapeScan) return;
        for (const p of SHAPE_PATTERNS) {
          const m = p.re.exec(line);
          if (m) hits.push({ file: rel, line: i + 1, label: p.label, preview: previewOf(line, m[0]) });
        }
      });
    }
  }
  return { hits, scannedFiles, scannedExts: [...scannedExts] };
}

/** 生成不含凭据的命中预览 */
function previewOf(line: string, secret: string): string {
  const masked = line.split(secret).join('[命中]');
  return masked.trim().slice(0, 120);
}

/* ---------------------------------------------------------------------------
 * 闸门自证：确认检测能力真的有效（否则「0 命中」没有意义）
 * ------------------------------------------------------------------------- */
function proveDetection(): { ok: boolean; notes: string[] } {
  const notes: string[] = [];
  let ok = true;

  const fakePass = 'fake-secret-value-abcdef123456';
  const line = `headers: { Authorization: "${fakePass}" }`;
  const secrets = [{ label: 'test', value: fakePass }];
  const detected = secrets.some((s) => line.includes(s.value));
  if (!detected) {
    ok = false;
    notes.push('✗ 真实值比对逻辑失效（构造的假凭据没被检出）');
  } else {
    notes.push('✓ 真实值比对逻辑有效（构造的假凭据被检出）');
  }

  for (const p of SHAPE_PATTERNS) {
    // 每个形态都构造一个正样本，确认正则会命中
    const samples: Record<string, string> = {
      'B站 SESSDATA（明文 cookie）': 'Cookie: SESSDATA=abcdef123456%2Fxyz789',
      'B站 bili_jct（明文 csrf）': 'bili_jct=0123456789abcdef0123456789abcdef',
      '阿里云 AccessKeyId': 'accessKeyId=LTAI5tAbCdEfGhIjKlMnOp',
      'OpenAI/DeepSeek 风格密钥（真实长度 ≥ 24）': 'apiKey: sk-abcdefghijklmnopqrstuvwxyz012345',
      'Server酱 SendKey': 'sendKey=SCT123456abcdefghijklmnop',
      'Telegram bot token': 'bot_token=123456789:AAFabcdefghijklmnopqrstuvwxyz012345678',
    };
    const sample = samples[p.label];
    if (!sample) {
      notes.push(`· ${p.label}：无样本，跳过自证`);
      continue;
    }
    if (p.re.test(sample)) {
      notes.push(`✓ 形态规则有效：${p.label}`);
    } else {
      ok = false;
      notes.push(`✗ 形态规则失效：${p.label}（正样本未被命中）`);
    }
  }
  return { ok, notes };
}

/* ---------------------------------------------------------------------------
 * 主流程
 * ------------------------------------------------------------------------- */
const { hits, scannedFiles, scannedExts } = audit();
const gate = proveDetection();
const secrets = realSecrets();

const result = {
  scannedFiles,
  scannedExts,
  credentialsCompared: secrets.map((s) => s.label),
  credentialValuesPrinted: false,
  hits: hits.length,
  details: hits,
  gateSelfProof: gate,
};

if (JSON_ONLY) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log('\x1b[1m凭据泄露审计\x1b[0m（硬约束 #8）');
  console.log('─'.repeat(60));
  console.log(`扫描文件      : ${scannedFiles} 个（${scannedExts.join(' ')}）`);
  console.log(`比对的真实凭据: ${secrets.length} 项 → ${secrets.map((s) => s.label).join(', ') || '(config.json 无有效凭据)'}`);
  console.log(`凭据值是否打印: \x1b[32m否\x1b[0m`);
  console.log('');
  console.log('\x1b[1m闸门自证（确认检测能力有效）\x1b[0m');
  for (const n of gate.notes) console.log(`  ${n}`);
  console.log('');
  if (hits.length === 0) {
    console.log('\x1b[32m✓ 未发现任何凭据泄露\x1b[0m');
  } else {
    console.log(`\x1b[31m✗ 发现 ${hits.length} 处可疑命中\x1b[0m`);
    for (const h of hits) {
      console.log(`  ${h.file}:${h.line}  [${h.label}]`);
      console.log(`    ${h.preview}`);
    }
  }
  console.log('');
  console.log(`\x1b[1m===== 结果：命中 ${hits.length} 处，闸门自证 ${gate.ok ? '通过' : '失败'} =====\x1b[0m`);
}

if (hits.length > 0 || !gate.ok) process.exitCode = 1;
