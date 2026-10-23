import * as persona from '@deepseek-ai/dsh-persona';
import * as files from '@deepseek-ai/dsh-tool-fs';
import * as search from '@deepseek-ai/dsh-tool-fs-search';

// These tools belong to one private child scope, not the selectable preset roster.
export async function mountResearcher(ctx) {
  const shell = process.platform === 'win32'
    ? await import('@deepseek-ai/dsh-tool-pwsh')
    : await import('@deepseek-ai/dsh-tool-bash');
  for (const [plugin, config] of [
    [persona, { prefix: 'You are a research agent completing one bounded SLA invocation. Follow the supplied role and workspace boundaries.' }],
    [files, {}],
    [search, { sampleOverCapGlobResults: false }],
    [shell, {}],
  ]) {
    const fiber = ctx.plugin(plugin, config);
    await fiber;
    const missing = Object.keys(fiber.inject).filter(name => fiber.ctx.get(name) === undefined);
    if (missing.length) throw new Error(`SLA 实验工具缺少服务：${missing.join(', ')}`);
  }
}
