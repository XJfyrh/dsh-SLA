// Optional helper for extensions using line-delimited command output.
// The engine does not depend on this protocol or a particular runtime.
export function parseResult(result) {
  if (result.aborted || result.timedOut || result.exitCode !== 0 || result.stdout.truncated) throw new Error(`评价没有完成：exit=${result.exitCode}，${result.stderr.text.slice(-1500)}`);
  const last = result.stdout.text.trim().split(/\r?\n/).at(-1);
  if (!last?.startsWith('SLA_RESULT ')) throw new Error('评价输出缺少最后一行 SLA_RESULT');
  return JSON.parse(last.slice(11));
}
