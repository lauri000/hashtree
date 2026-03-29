/**
 * Git operations - mix of native (fast) and wasm-git (for writes)
 *
 * Native functions read directly from hashtree/pack files - fast for reads
 * Wasm functions use libgit2 compiled to WebAssembly - needed for writes
 */

// Native implementations (fast, read-only)
export {
  getHead,
  getLog,
  getCommitInfo,
  getRootCommit,
  getLogWasm,
  getCommitCount,
  getCommitCountFast,
  getCommitDiffEntries,
  getFileLastCommits,
  getDiff,
  getFileAtCommit,
} from './log';
export type { CommitInfo, CommitDetails, DiffEntry } from './log';

export { getBranches, getRefs } from './branch';
export type { GitRefsResult } from './branch';
export { parsePackedRefs } from './refs';
export type { GitTreeReader, PackedRefEntry } from './refs';

// Wasm implementations (slower, but handle writes correctly)
export { createBranchWasm } from './branch';

export { getStatusWasm } from './status';
export type { GitStatusEntry, GitStatusResult } from './status';

export { initRepoWasm, commitWasm } from './commit';

export { checkoutWasm } from './checkout';

export { runGitCommand } from './command';

export { diffBranchesWasm, canMergeWasm } from './diff';
export type { BranchDiffStats, BranchDiffResult } from './diff';

export { mergeWasm } from './merge';
export type { MergeResult } from './merge';
