/**
 * Branch diff operations using wasm-git
 */
import type { CID } from '@hashtree/core';
import { LinkType } from '@hashtree/core';
import { getTree } from '../../store';
import { withWasmGitLock, loadWasmGit, copyToWasmFS, copyGitDirToWasmFS, createRepoPath, rmRf } from './core';
import { getErrorMessage } from '../errorMessage';
import { copyGitObjectPayloadsToWasmFS } from './objectImport';

export interface BranchDiffStats {
  additions: number;
  deletions: number;
  files: string[];
}

export interface BranchDiffResult {
  diff: string;
  stats: BranchDiffStats;
  canFastForward: boolean;
  error?: string;
}

function emptyDiffResult(error?: string): BranchDiffResult {
  return {
    diff: '',
    stats: { additions: 0, deletions: 0, files: [] },
    canFastForward: false,
    error,
  };
}

/**
 * Parse diff output to extract stats
 */
function parseDiffStats(diff: string): BranchDiffStats {
  const stats: BranchDiffStats = {
    additions: 0,
    deletions: 0,
    files: [],
  };

  const lines = diff.split('\n');
  const filesSet = new Set<string>();

  for (const line of lines) {
    if (line.startsWith('diff --git')) {
      const match = line.match(/diff --git a\/(.*) b\/(.*)/);
      if (match) filesSet.add(match[2]);
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      stats.additions++;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      stats.deletions++;
    }
  }

  stats.files = Array.from(filesSet);
  return stats;
}

async function copyGitObjectsToWasmFS(module: Awaited<ReturnType<typeof loadWasmGit>>, rootCid: CID, destGitObjectsPath: string): Promise<void> {
  const tree = getTree();
  const objectsResult = await tree.resolvePath(rootCid, '.git/objects');
  if (!objectsResult || objectsResult.type !== LinkType.Dir) {
    throw new Error('Source repository is missing .git/objects');
  }

  try {
    module.FS.mkdir(destGitObjectsPath);
  } catch {
    // Directory may already exist
  }
  await copyGitObjectPayloadsToWasmFS(module, objectsResult.cid, destGitObjectsPath);
}

/**
 * Get diff between two branches
 */
export async function diffBranchesWasm(
  rootCid: CID,
  baseBranch: string,
  headBranch: string
): Promise<BranchDiffResult> {
  return withWasmGitLock(async () => {
    const tree = getTree();

    // Check for .git directory
    const gitDirResult = await tree.resolvePath(rootCid, '.git');
    if (!gitDirResult || gitDirResult.type !== LinkType.Dir) {
      return emptyDiffResult('Not a git repository');
    }

    const module = await loadWasmGit();
    const repoPath = createRepoPath();
    const originalCwd = module.FS.cwd();

    try {
      module.FS.mkdir(repoPath);
      module.FS.chdir(repoPath);

      // Read-only branch diff only needs git metadata/objects, not the full working tree.
      await copyGitDirToWasmFS(module, rootCid, '.');

      // Resolve refs explicitly first. Some wasm-git diff paths can return empty output
      // for missing refs instead of failing, which looks like "no changes" in the UI.
      let baseCommit = '';
      let headCommit = '';
      try {
        baseCommit = (module.callWithOutput(['rev-parse', baseBranch]) || '').trim();
        headCommit = (module.callWithOutput(['rev-parse', headBranch]) || '').trim();
        if (!baseCommit || !headCommit) {
          return {
            diff: '',
            stats: { additions: 0, deletions: 0, files: [] },
            canFastForward: false,
            error: `Failed to resolve branch refs: ${baseBranch} ${headBranch}`,
          };
        }
      } catch (_err) {
        const errorMsg = _err instanceof Error ? _err.message : String(_err);
        return emptyDiffResult(`Failed to resolve branch refs: ${errorMsg}`);
      }

      // Compute commit-to-commit diff after explicit ref resolution.
      // Using commit SHAs avoids the silent "missing ref => empty diff" behavior.
      let diff = '';
      try {
        diff = module.callWithOutput(['diff', baseCommit, headCommit]) || '';
      } catch (_err) {
        const errorMsg = _err instanceof Error ? _err.message : String(_err);
        return emptyDiffResult(`Failed to diff branches: ${errorMsg}`);
      }

      const stats = parseDiffStats(diff);

      // Check if this can be a fast-forward merge
      // Fast-forward is possible if base is an ancestor of head
      let canFastForward = false;
      try {
        const mergeBaseOutput = module.callWithOutput(['merge-base', baseBranch, headBranch]) || '';
        const mergeBase = mergeBaseOutput.trim();

        // If merge-base equals base branch, it's a fast-forward
        canFastForward = mergeBase === baseCommit;
      } catch {
        // If merge-base fails, assume not fast-forward
        canFastForward = false;
      }

      return { diff, stats, canFastForward };
    } catch (err) {
      console.error('[wasm-git] diffBranches failed:', err);
      return emptyDiffResult(getErrorMessage(err));
    } finally {
      try {
        module.FS.chdir(originalCwd);
      } catch {
        // Ignore
      }
      try {
        rmRf(module, repoPath);
      } catch {
        // Ignore cleanup errors
      }
    }
  });
}

/**
 * Compute a diff between a target branch in one repo and a specific commit in another repo.
 * Used for cross-repo pull requests where the source branch lives in a contributor fork.
 */
export async function diffCommitsAcrossReposWasm(
  targetRootCid: CID,
  targetBranch: string,
  sourceRootCid: CID,
  sourceCommitTip: string
): Promise<BranchDiffResult> {
  return withWasmGitLock(async () => {
    const tree = getTree();
    const targetGitDirResult = await tree.resolvePath(targetRootCid, '.git');
    if (!targetGitDirResult || targetGitDirResult.type !== LinkType.Dir) {
      return emptyDiffResult('Target repository is missing .git');
    }

    const sourceGitDirResult = await tree.resolvePath(sourceRootCid, '.git');
    if (!sourceGitDirResult || sourceGitDirResult.type !== LinkType.Dir) {
      return emptyDiffResult('Source repository is missing .git');
    }

    const module = await loadWasmGit();
    const repoPath = createRepoPath('pr-diff');
    const originalCwd = module.FS.cwd();

    try {
      module.FS.mkdir(repoPath);
      module.FS.chdir(repoPath);

      // Start from the target repo's .git so refs/HEAD resolve against the target branch.
      await copyGitDirToWasmFS(module, targetRootCid, '.');

      let targetCommit = '';
      try {
        targetCommit = (module.callWithOutput(['rev-parse', targetBranch]) || '').trim();
        if (!targetCommit) {
          return emptyDiffResult(`Failed to resolve target branch ref: ${targetBranch}`);
        }
      } catch (_err) {
        const errorMsg = _err instanceof Error ? _err.message : String(_err);
        return emptyDiffResult(`Failed to resolve target branch ref: ${errorMsg}`);
      }

      // Merge source objects into the target repo object database so source commit/tree/blob data is available.
      try {
        await copyGitObjectsToWasmFS(module, sourceRootCid, './.git/objects');
      } catch (_err) {
        const errorMsg = _err instanceof Error ? _err.message : String(_err);
        return emptyDiffResult(`Failed to import source repository objects: ${errorMsg}`);
      }

      const sourceCommit = sourceCommitTip.trim();
      if (!sourceCommit) {
        return emptyDiffResult('Cross-repo diff requires a commit tip (c tag) in the pull request event.');
      }

      try {
        const objectType = (module.callWithOutput(['cat-file', '-t', sourceCommit]) || '').trim();
        if (objectType !== 'commit') {
          return emptyDiffResult(`Source commit tip is not a commit object: ${sourceCommit}`);
        }
      } catch (_err) {
        const errorMsg = _err instanceof Error ? _err.message : String(_err);
        return emptyDiffResult(`Failed to resolve source commit tip: ${errorMsg}`);
      }

      let diff = '';
      try {
        diff = module.callWithOutput(['diff', targetCommit, sourceCommit]) || '';
      } catch (_err) {
        const errorMsg = _err instanceof Error ? _err.message : String(_err);
        return emptyDiffResult(`Failed to diff commits: ${errorMsg}`);
      }

      const stats = parseDiffStats(diff);

      let canFastForward = false;
      try {
        const mergeBaseOutput = module.callWithOutput(['merge-base', targetCommit, sourceCommit]) || '';
        const mergeBase = mergeBaseOutput.trim();
        canFastForward = mergeBase === targetCommit;
      } catch {
        canFastForward = false;
      }

      return { diff, stats, canFastForward };
    } catch (err) {
      console.error('[wasm-git] diffCommitsAcrossRepos failed:', err);
      return emptyDiffResult(getErrorMessage(err));
    } finally {
      try {
        module.FS.chdir(originalCwd);
      } catch {
        // Ignore
      }
      try {
        rmRf(module, repoPath);
      } catch {
        // Ignore cleanup errors
      }
    }
  });
}

/**
 * Check if branches can be merged without conflicts
 */
export async function canMergeWasm(
  rootCid: CID,
  baseBranch: string,
  headBranch: string
): Promise<{ canMerge: boolean; conflicts: string[]; isFastForward: boolean; error?: string }> {
  return withWasmGitLock(async () => {
    const tree = getTree();

    // Check for .git directory
    const gitDirResult = await tree.resolvePath(rootCid, '.git');
    if (!gitDirResult || gitDirResult.type !== LinkType.Dir) {
      return { canMerge: false, conflicts: [], isFastForward: false, error: 'Not a git repository' };
    }

    const module = await loadWasmGit();
    const repoPath = createRepoPath();
    const originalCwd = module.FS.cwd();

    try {
      module.FS.mkdir(repoPath);
      module.FS.chdir(repoPath);

      await copyToWasmFS(module, rootCid, '.');

      // Check for fast-forward possibility
      let isFastForward = false;
      try {
        const mergeBaseOutput = module.callWithOutput(['merge-base', baseBranch, headBranch]) || '';
        const mergeBase = mergeBaseOutput.trim();

        const baseRefOutput = module.callWithOutput(['rev-parse', baseBranch]) || '';
        const baseCommit = baseRefOutput.trim();

        isFastForward = mergeBase === baseCommit;
      } catch {
        isFastForward = false;
      }

      // If fast-forward, no conflicts possible
      if (isFastForward) {
        return { canMerge: true, conflicts: [], isFastForward: true };
      }

      // Checkout base branch first
      try {
        module.callWithOutput(['checkout', baseBranch]);
      } catch (_err) {
        const errorMsg = _err instanceof Error ? _err.message : String(_err);
        return { canMerge: false, conflicts: [], isFastForward: false, error: `Failed to checkout ${baseBranch}: ${errorMsg}` };
      }

      // Try merge with --no-commit to check for conflicts
      try {
        module.callWithOutput(['merge', '--no-commit', '--no-ff', headBranch]);
        // If we get here, merge is possible
        // Abort the merge to clean up
        try {
          module.callWithOutput(['merge', '--abort']);
        } catch {
          // Ignore abort errors
        }
        return { canMerge: true, conflicts: [], isFastForward: false };
      } catch {
        // Merge failed, check for conflicts
        const conflicts: string[] = [];
        try {
          const statusOutput = module.callWithOutput(['status', '--porcelain']) || '';
          const lines = statusOutput.split('\n');
          for (const line of lines) {
            // UU = both modified (conflict)
            // AA = both added
            // DD = both deleted
            if (line.match(/^(UU|AA|DD|AU|UA|DU|UD)/)) {
              const file = line.slice(3).trim();
              if (file) conflicts.push(file);
            }
          }
        } catch {
          // Can't get status
        }

        // Abort the merge
        try {
          module.callWithOutput(['merge', '--abort']);
        } catch {
          // Ignore abort errors
        }

        return { canMerge: conflicts.length === 0, conflicts, isFastForward: false };
      }
    } catch (_err) {
      console.error('[wasm-git] canMerge failed:', _err);
      return { canMerge: false, conflicts: [], isFastForward: false, error: _err instanceof Error ? _err.message : String(_err) };
    } finally {
      try {
        module.FS.chdir(originalCwd);
      } catch {
        // Ignore
      }
      try {
        rmRf(module, repoPath);
      } catch {
        // Ignore cleanup errors
      }
    }
  });
}
