import * as path from 'path';

/**
 * Path of `fileFsPath` relative to `rootFsPath`, using forward slashes.
 * Returns undefined when the file is the root itself or lies outside it.
 */
export function workspaceRelativePath(rootFsPath: string, fileFsPath: string): string | undefined {
  const relative = path.relative(path.resolve(rootFsPath), path.resolve(fileFsPath));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return undefined;
  }
  return relative.split(path.sep).join('/');
}

/**
 * Workspace root that should own comments for a file.
 * A multi-root window can contain the file in any listed root; the longest
 * matching root wins when roots are nested. The first root is not special.
 */
export function commentRootForFile(
  rootFsPaths: readonly string[],
  fileFsPath: string
): string | undefined {
  let best: string | undefined;
  let bestLength = -1;
  for (const rootFsPath of rootFsPaths) {
    const resolved = path.resolve(rootFsPath);
    if (workspaceRelativePath(resolved, fileFsPath) === undefined) {
      continue;
    }
    if (resolved.length > bestLength) {
      best = resolved;
      bestLength = resolved.length;
    }
  }
  return best;
}
