// Publishes dist/ to the `gh-pages` branch of this repo's `origin` (GitHub Pages serves that branch).
// Usage: npm run deploy   (builds first)
import { execSync } from 'node:child_process';
import { writeFileSync, existsSync } from 'node:fs';

const run = (cmd, cwd) => execSync(cmd, { cwd, stdio: 'inherit' });
const origin = execSync('git remote get-url origin').toString().trim();
if (!existsSync('dist/index.html')) throw new Error('dist/ is missing – run `npm run build` first');

writeFileSync('dist/.nojekyll', ''); // serve files as-is (no Jekyll processing)
run('git init -q -b gh-pages', 'dist');
run('git add -A', 'dist');
run('git commit -q -m "Deploy to GitHub Pages"', 'dist');
run(`git push -f "${origin}" gh-pages`, 'dist');
console.log('Deployed dist/ to the gh-pages branch.');
