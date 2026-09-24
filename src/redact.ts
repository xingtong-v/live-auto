/**
 * 凭据脱敏工具。
 *
 * 硬约束 #8 / 陷阱 #33：日志、错误报告、配置示例中不得留存真实
 * passkey / cookie / API Key。所有出站文本一律经此模块处理，
 * 禁止裸打印 request 对象。
 */

/** 需要整体遮蔽的键名（大小写不敏感匹配，含子串匹配） */
const SECRET_KEY_PATTERNS: RegExp[] = [
  /passkey/i,
  /pass_key/i,
  /authorization/i,
  /^auth$/i,
  /\bauth\b/i,
  /cookie/i,
  /sessionid/i,
  /bili_jct/i,
  /sessdata/i,
  /access_?key/i,
  /secret/i,
  /api_?key/i,
  /apikey/i,
  /token/i,
  /password/i,
  /passwd/i,
  /credential/i,
  /signature/i,
  /send_?key/i,
  /private_?key/i,
  /webhook/i,
  /^key$/i,
];

/** 值内联出现的密钥形态（用于自由文本脱敏） */
const SECRET_VALUE_PATTERNS: Array<[RegExp, string]> = [
  // ---- 已知键名 + 任意值形态 ----
  // ① 引号包裹的 JSON/KV：`"passKey":"0.7df1eg"` / `apiKey': 'sk-xxx'`
  // ⚠️ 早期版本只按「敏感键 → maskValue」处理结构化对象，自由文本里的
  //    `"passKey":"0.9EXAMPLEfake11"` 会整体漏网（test/redact-selftest.ts 抓到的真实漏洞）。
  [
    /(["']?(?:passkey|pass_key|api_?key|apikey|access_?key|secret|secret_?key|client_?secret|bot_?token|send_?key|sendkey|private_?key|password|passwd|auth|authorization|token|cookie|signature|credential)["']?\s*[:=]\s*)(["'])([^"'\r\n]{4,})\2/gi,
    '$1$2***REDACTED***$2',
  ],
  // ② 非引号 KV：`passKey=0.9EXAMPLEfake11` / `apiKey: sk-xxx` / `Authorization: xxx`
  [
    /\b(passkey|pass_key|api_?key|apikey|access_?key|secret_?key|client_?secret|bot_?token|send_?key|sendkey|private_?key|password|passwd|authorization|cookie|signature|credential)\b\s*[:=]\s*([^\s,;"'}\r\n]{4,})/gi,
    '$1=***REDACTED***',
  ],
  // ③ Authorization / Cookie 头（值里可能含空格或冒号，例如 "Bearer xxx"）
  [/\b(Authorization\s*[:=]\s*)([^\r\n,;}]+)/gi, '$1***REDACTED***'],
  [/\b(Cookie\s*[:=]\s*)([^\r\n]+)/gi, '$1***REDACTED***'],
  // ④ Bearer / Basic 认证
  [/\b(Bearer\s+)([A-Za-z0-9._~+/=-]{8,})/gi, '$1***REDACTED***'],
  [/\b(Basic\s+)([A-Za-z0-9+/=]{8,})/gi, '$1***REDACTED***'],
  // ⑤ 已知前缀的密钥
  [/\b(sk-[A-Za-z0-9_.\-]{6,})/g, 'sk-***REDACTED***'],
  [/\b(SCT[A-Za-z0-9]{6,})/g, 'SCT***REDACTED***'],
  [/\b(LTAI[A-Za-z0-9]{8,})/g, 'LTAI***REDACTED***'],
  // ⑥ URL query 凭据
  [/([?&](?:auth|passkey|pass_key|key|token|access_token|sign|signature)=)([^&\s#]+)/gi, '$1***REDACTED***'],
  // ⑦ B站 cookie 片段
  [
    /\b(SESSDATA|bili_jct|DedeUserID|DedeUserID__ckMd5|buvid3|buvid4|sid|sessionid|sid_tt|uid_tt|access_key)=([^;\s&"']+)/gi,
    '$1=***REDACTED***',
  ],
  // ⑧ 通用 `token=` / `key=` / `secret=`（键名短且常见，放最后）
  [/\b(token|key|auth|pwd|sig|sign)\s*[:=]\s*([^\s,;"'}\r\n]{6,})/gi, '$1=***REDACTED***'],
  // ⑨ 兜底：等号/冒号后紧跟的长随机串（≥16 位无空格、非 URL、非句子的紧凑串）
  //    注意这条故意做得保守，避免误伤正常文本（标题、简介里不会出现这种形态）
  [/([:=]\s*)([A-Za-z0-9_\-]{16,})(?=[\s,;"'}\]]|$)/g, '$1***REDACTED***'],
];

/**
 * 遮蔽单个敏感值：保留首尾各若干字符，便于人工比对是否为同一个 key，
 * 但不足以还原。长度不足时整体遮蔽。
 */
export function maskValue(value: string): string {
  const v = String(value);
  if (!v) return v;
  // Authorization 这类本来就是「前缀 + 值」的形式，整体遮蔽更安全
  if (v.length <= 8) return '***';
  const head = v.slice(0, 3);
  const tail = v.slice(-2);
  return `${head}***${tail}(len=${v.length})`;
}

/** 判断键名是否属于敏感键 */
export function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERNS.some((re) => re.test(key));
}

/**
 * 深度脱敏任意结构，返回新对象（不修改入参）。
 * - 敏感键的值 → 遮蔽
 * - 字符串值 → 内联密钥形态替换
 * - 限制深度与数组长度，避免巨型对象刷爆日志
 */
export function redact<T>(input: T, opts: { maxDepth?: number; maxArray?: number; maxString?: number } = {}): unknown {
  const maxDepth = opts.maxDepth ?? 6;
  const maxArray = opts.maxArray ?? 20;
  const maxString = opts.maxString ?? 4096;

  const walk = (value: unknown, depth: number, key?: string): unknown => {
    if (key !== undefined && isSecretKey(key)) {
      if (value === undefined || value === null) return value;
      return maskValue(typeof value === 'string' ? value : JSON.stringify(value));
    }
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') {
      return redactText(value.slice(0, maxString));
    }
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return value;
    if (typeof value === 'function') return '[Function]';
    if (depth >= maxDepth) return '[深度截断]';
    if (Array.isArray(value)) {
      const arr = value.slice(0, maxArray).map((v) => walk(v, depth + 1));
      if (value.length > maxArray) arr.push(`[还有 ${value.length - maxArray} 项]`);
      return arr;
    }
    if (value instanceof Error) {
      return { name: value.name, message: redactText(value.message), stack: redactText(value.stack ?? '') };
    }
    if (typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = walk(v, depth + 1, k);
      }
      return out;
    }
    return String(value);
  };

  return walk(input, 0);
}

/** 对自由文本做内联密钥形态替换 */
export function redactText(text: string): string {
  let out = text;
  for (const [re, rep] of SECRET_VALUE_PATTERNS) {
    out = out.replace(re, rep);
  }
  return out;
}

/** 脱敏后的 JSON 字符串 */
export function redactJson(value: unknown, space?: number): string {
  return JSON.stringify(redact(value), null, space);
}
