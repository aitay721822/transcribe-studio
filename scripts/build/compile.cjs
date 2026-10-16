const esbuild = require('esbuild');
const fs = require('node:fs/promises');
const path = require('node:path');
const { compileStyles } = require('./styles.cjs');
const { compileBranding } = require('./branding.cjs');
const { compileWindowsHost } = require('./windows.cjs');

const root = path.resolve(__dirname, '../..');
process.chdir(root);

async function main() {
  await compileBranding(root);
  const buildDir = path.resolve(root, 'dist');
  if (buildDir !== path.join(root, 'dist') || path.dirname(buildDir) !== root)
    throw new Error('Unsafe build directory');
  await fs.rm(buildDir, { recursive: true, force: true });
  await compileWindowsHost(root);
  const entries = [
    'main',
    'transport/preload',
    'transport/asr',
    'transport/codex-rpc',
    'transport/runtime/launch',
    'persistence/store',
    'persistence/conversations',
    'harness/coordinator',
    'harness/skills',
    'ai/adapters/claude',
    'ai/adapters/openai',
    'transport/claude/process',
    'transport/claude/gateway',
    'domain/agents/auth',
    'domain/agents/limits',
    'domain/agents/trace',
    'domain/agents/compression',
    'harness/prompt',
    'harness/context/compact',
    'services/agents/config',
    'services/agents/login',
    'services/agents/errors',
    'ai/adapters/codex',
    'services/agents/detection',
    'services/diagnostics/asr',
    'services/diagnostics/agent',
    'services/diagnostics/settings',
    'desktop/diagnostics/routes',
    'services/agents/executable',
    'domain/readiness',
    'ui/setup/gate',
    'domain/annotations',
    'domain/audio-devices',
    'domain/transcription',
    'domain/asr/realtime',
    'transport/transcription/request',
    'transport/transcription/file',
    'transport/transcription/pipeline/worker',
    'transport/transcription/session',
    'transport/transcription/wav',
    'desktop/ipc/imports',
    'harness/revisions/annotations',
    'services/workspace/files',
    'services/workspace/worker',
    'services/workspace/references/resolve',
    'domain/references/context',
    'services/agents/conversation/images',
    'services/agents/conversation/temporary',
    'desktop/agent-routes',
    'services/documents/export-docx',
    'services/meetings/transcript',
    'services/meetings/lifecycle',
    'services/meetings/history',
    'services/projects/lifecycle',
    'services/projects/edit-session',
  ];
  await esbuild.build({
    entryPoints: entries.map((n) => `src/${n}.ts`),
    outdir: 'dist',
    outbase: 'src',
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    packages: 'external',
    sourcemap: 'inline',
    outExtension: { '.js': '.cjs' },
  });
  await esbuild.build({
    entryPoints: ['src/ui/app.tsx', 'src/ui/audio/pcm-worklet.ts'],
    outdir: 'dist/ui',
    outbase: 'src/ui',
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'chrome140',
    sourcemap: 'inline',
  });
  await fs.mkdir('dist/ui/styles', { recursive: true });
  await fs.copyFile('src/ui/index.html', 'dist/ui/index.html');
  await fs.mkdir('dist/ui/branding', { recursive: true });
  for (const filename of ['icon.svg', 'mark.svg', 'logo.svg'])
    await fs.copyFile(
      path.join('config/branding', filename),
      path.join('dist/ui/branding', filename)
    );
  await fs.copyFile('config/branding/native/icon.png', 'dist/ui/branding/icon.png');
  await fs.cp('src/ui/styles', 'dist/ui/styles', { recursive: true });
  await compileStyles(root);
  console.log('TypeScript sources compiled to dist/.');
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
