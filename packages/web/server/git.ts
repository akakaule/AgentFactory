// Git diff utilities now live in @agentfactory/core so the reviewer supervisor
// (packages/reviewer) can reuse them without depending on web. Re-exported here
// so web routes/tests keep their existing import path ('../git.js').
export { branchDiff, resolveBaseRef, GitError, type BranchDiff } from '@agentfactory/core';
