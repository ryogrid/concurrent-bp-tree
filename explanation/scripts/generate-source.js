// Run after editing Go: node explanation/scripts/generate-source.js
// --check fails when the checked-in browser source differs from the Go files.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const files = {};
for (const name of fs.readdirSync(path.join(root, 'bptree')).filter(n => n.endsWith('.go') && !n.endsWith('_test.go')).sort()) {
  files[name] = fs.readFileSync(path.join(root, 'bptree', name), 'utf8').trimEnd().split('\n');
}
const output = '// Generated from bptree/*.go; do not edit.\nglobalThis.GoSource = ' + JSON.stringify(files, null, 2) + ';\n';
const target = path.join(root, 'explanation/shared/go-source.js');
if (process.argv.includes('--check')) {
  if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== output) {
    console.error('Go source changed: run node explanation/scripts/generate-source.js');
    process.exitCode = 1;
  }
} else fs.writeFileSync(target, output);
