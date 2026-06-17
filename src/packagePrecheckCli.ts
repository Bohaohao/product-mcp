import { precheckProductPackage } from './packagePrecheck.js';

function parseArgs() {
  const args = process.argv.slice(2);
  const summary = args.includes('--summary');
  const packagePath = args.find((arg) => arg !== '--summary');
  if (!packagePath) {
    throw new Error('Usage: node dist/packagePrecheckCli.js [--summary] <packagePath-or-markdownPath>');
  }
  return { packagePath, summary };
}

async function main() {
  const { packagePath, summary } = parseArgs();
  const result = await precheckProductPackage({
    packagePath,
    includeDraft: true
  });
  const output = summary
    ? {
        ok: result.ok,
        packageDir: result.packageDir,
        markdownPath: result.markdownPath,
        summary: result.summary,
        readiness: result.readiness,
        issues: result.issues,
        uploadQueue: result.uploadQueue.map((item) => ({
          usage: item.usage,
          localPath: item.localPath,
          title: item.title,
          imagePreparation: item.imagePreparation,
          source: item.source,
          suggestedMapping: item.suggestedMapping
        }))
      }
    : result;
  console.log(JSON.stringify(output, null, 2));
  process.exitCode = result.ok ? 0 : 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
