/**
 * Git ref operations
 */
import type { CID } from '@hashtree/core';
import { LinkType } from '@hashtree/core';
import { getTree } from '../../store';
import { withWasmGitLock, loadWasmGit, copyToWasmFS, runSilent, rmRf, readGitDirectory, createRepoPath, fixBareConfig } from './core';
import { getErrorMessage } from '../errorMessage';
import { collectLooseRefs, isFullSha, readPackedRefs, type GitTreeReader } from './refs';
import { resolveRevisionToCommit } from './log';

export interface GitRefsResult {
  branches: string[];
  currentBranch: string | null;
  tags: string[];
  tagsByCommit: Record<string, string[]>;
}

interface GetRefsOptions {
  tree?: GitTreeReader;
  resolveRevisionToCommit?: (rootCid: CID, revision: string) => Promise<string | null>;
}

function sortedRefNames(values: Iterable<string>): string[] {
  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
}

/**
 * Get branches and tags by reading directly from hashtree.
 * No wasm-git needed for read-only ref discovery.
 */
export async function getRefs(
  rootCid: CID,
  options: GetRefsOptions = {}
): Promise<GitRefsResult> {
  const tree = options.tree ?? getTree();
  const resolveCommit = options.resolveRevisionToCommit ?? resolveRevisionToCommit;

  // Check for .git directory
  const gitDirResult = await tree.resolvePath(rootCid, '.git');
  if (!gitDirResult || gitDirResult.type !== LinkType.Dir) {
    return { branches: [], currentBranch: null, tags: [], tagsByCommit: {} };
  }

  // Read HEAD file to get current branch
  let currentBranch: string | null = null;
  let headIsDetached = false;
  try {
    const headResult = await tree.resolvePath(gitDirResult.cid, 'HEAD');
    if (headResult && headResult.type !== LinkType.Dir) {
      const headData = await tree.readFile(headResult.cid);
      if (headData) {
        const headContent = new TextDecoder().decode(headData).trim();
        const refMatch = headContent.match(/^ref: refs\/heads\/(\S+)/);
        if (refMatch) {
          currentBranch = refMatch[1];
        } else if (isFullSha(headContent)) {
          headIsDetached = true;
        }
        // If no match, HEAD is a direct SHA (detached state) - currentBranch stays null
      }
    }
  } catch {
    // HEAD file not found or unreadable
  }

  const looseHeads = await collectLooseRefs(tree, gitDirResult.cid, 'refs/heads');
  const looseTags = await collectLooseRefs(tree, gitDirResult.cid, 'refs/tags');
  const packedRefs = await readPackedRefs(tree, gitDirResult.cid);

  const branches = sortedRefNames([
    ...looseHeads.keys(),
    ...Array.from(packedRefs.keys())
      .filter((refPath) => refPath.startsWith('refs/heads/'))
      .map((refPath) => refPath.slice('refs/heads/'.length)),
  ]);

  const tags = sortedRefNames([
    ...looseTags.keys(),
    ...Array.from(packedRefs.keys())
      .filter((refPath) => refPath.startsWith('refs/tags/'))
      .map((refPath) => refPath.slice('refs/tags/'.length)),
  ]);

  const tagsByCommit: Record<string, string[]> = {};
  for (const tag of tags) {
    const commitSha = await resolveCommit(rootCid, `refs/tags/${tag}`);
    if (!commitSha) continue;
    tagsByCommit[commitSha] ??= [];
    tagsByCommit[commitSha].push(tag);
  }

  for (const tagList of Object.values(tagsByCommit)) {
    tagList.sort((a, b) => a.localeCompare(b));
  }

  if (!currentBranch && !headIsDetached && branches.length > 0) {
    if (branches.includes('main')) {
      currentBranch = 'main';
    } else if (branches.includes('master')) {
      currentBranch = 'master';
    } else {
      currentBranch = branches[0];
    }
  }

  return { branches, currentBranch, tags, tagsByCommit };
}

export async function getBranches(
  rootCid: CID,
  options: GetRefsOptions = {}
): Promise<GitRefsResult> {
  return getRefs(rootCid, options);
}

/**
 * Create a new branch using wasm-git
 * Returns the updated .git files that must be persisted to hashtree
 */
export async function createBranchWasm(
  rootCid: CID,
  branchName: string,
  checkout: boolean = true
): Promise<{ success: boolean; error?: string; gitFiles?: Array<{ name: string; data: Uint8Array; isDir: boolean }> }> {
  return withWasmGitLock(async () => {
    const tree = getTree();

    // Check for .git directory
    const gitDirResult = await tree.resolvePath(rootCid, '.git');
    if (!gitDirResult || gitDirResult.type !== LinkType.Dir) {
      return { success: false, error: 'Not a git repository' };
    }

    const module = await loadWasmGit();
    const repoPath = createRepoPath();
    const originalCwd = module.FS.cwd();

    try {
      module.FS.mkdir(repoPath);

      try {
        module.FS.writeFile('/home/web_user/.gitconfig', '[user]\nname = User\nemail = user@example.com\n');
      } catch {
        // May already exist
      }

      module.FS.chdir(repoPath);

      await copyToWasmFS(module, rootCid, '.');
      fixBareConfig(module);

      // Create the branch
      try {
        if (checkout) {
          runSilent(module, ['checkout', '-b', branchName]);
        } else {
          runSilent(module, ['branch', branchName]);
        }

        // Read updated .git files to return for persistence
        const gitFiles = readGitDirectory(module);
        return { success: true, gitFiles };
      } catch (err) {
        const message = getErrorMessage(err);
        return { success: false, error: message };
      }
    } catch (err) {
      console.error('[wasm-git] createBranch failed:', err);
      return { success: false, error: 'Failed to create branch' };
    } finally {
      try {
        module.FS.chdir(originalCwd);
        rmRf(module, repoPath);
      } catch {
        // Ignore
      }
    }
  });
}
