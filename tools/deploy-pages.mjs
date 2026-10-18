// Publishes dist/ to the `gh-pages` branch of `origin` (GitHub Pages serves that branch).
// Usage: npm run deploy   (builds first)
//
// Commits dist/ as its own root tree using a temporary index, so the main branch and working tree are
// untouched and no nested repository is needed (nested .git folders hit path-length limits on Windows).
import { execSync } from 'node:child_process';
import { writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (!existsSync('dist/index.html')) throw new Error('dist/ is missing – run `npm run build` first');
writeFileSync('dist/.nojekyll', ''); // serve files as-is (no Jekyll processing)

const index = join(tmpdir(), `tt-pages-index-${process.pid}`);
const git = (args) => execSync(`git ${args}`, { env: { ...process.env, GIT_INDEX_FILE: index } }).toString().trim();
try {
  git('--work-tree=dist add -A .');
  const tree = git('write-tree');
  const commit = git(`commit-tree ${tree} -m "Deploy to GitHub Pages"`);
  execSync(`git push -f origin ${commit}:refs/heads/gh-pages`, { stdio: 'inherit' });
  console.log(`Deployed dist/ (${commit.slice(0, 7)}) to the gh-pages branch.`);
} finally {
  rmSync(index, { force: true });
}
