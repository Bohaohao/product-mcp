import path from 'node:path';

export type MaterialPackageWriteKind = 'materialMarkdown' | 'generatedArtifact';

export interface MaterialPackageWriteCheck {
  packageDir: string;
  targetPath: string;
  kind: MaterialPackageWriteKind;
  markdownFileName?: string;
}

function normalizedRelative(packageDir: string, targetPath: string): string {
  const packageRoot = path.resolve(packageDir);
  const target = path.resolve(targetPath);
  const relative = path.relative(packageRoot, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing to write outside the material package boundary: ${target}`);
  }
  return relative.replace(/\\/g, '/');
}

function hasUnsafeSegment(relativePath: string): boolean {
  return relativePath.split('/').some((part) => part === '.git' || part === 'node_modules' || part === '..');
}

function isRootMarkdown(relativePath: string, markdownFileName: string): boolean {
  return relativePath === markdownFileName && path.basename(markdownFileName) === markdownFileName;
}

function isGeneratedArtifact(relativePath: string): boolean {
  return relativePath === '.generated' || relativePath.startsWith('.generated/');
}

export function assertMaterialPackageWrite(input: MaterialPackageWriteCheck): { relativePath: string } {
  const relativePath = normalizedRelative(input.packageDir, input.targetPath);
  if (hasUnsafeSegment(relativePath)) {
    throw new Error(`Refusing to write into protected material package path: ${relativePath}`);
  }

  if (input.kind === 'materialMarkdown') {
    const markdownFileName = input.markdownFileName || '商品资料.md';
    if (!isRootMarkdown(relativePath, markdownFileName)) {
      throw new Error(
        `Refusing to rewrite material package file ${relativePath}. Only the root ${markdownFileName} document may be generated or updated.`
      );
    }
    return { relativePath };
  }

  if (input.kind === 'generatedArtifact') {
    if (!isGeneratedArtifact(relativePath)) {
      throw new Error(`Refusing to create derived artifact outside .generated/: ${relativePath}`);
    }
    return { relativePath };
  }

  throw new Error(`Unsupported material package write kind: ${String(input.kind)}`);
}
