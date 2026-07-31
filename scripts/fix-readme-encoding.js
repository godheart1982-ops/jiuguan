const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'README.md');
let text = fs.readFileSync(file, 'utf8');
// strip existing BOM if any
if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

// Fix stale versionCode in docs
text = text.replace(/`versionCode` 113/g, '`versionCode` 115');
text = text.replace(/2\.1\.61\*\* \/ \*\*113/g, '2.1.61** / **115');

const bom = Buffer.from([0xef, 0xbb, 0xbf]);
const body = Buffer.from(text, 'utf8');
fs.writeFileSync(file, Buffer.concat([bom, body]));

const check = fs.readFileSync(file);
console.log('BOM ok:', check[0] === 0xef && check[1] === 0xbb && check[2] === 0xbf);
console.log('Head:', check.slice(3, 50).toString('utf8'));
console.log('Contains 酒馆:', check.toString('utf8').includes('酒馆'));
