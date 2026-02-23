const fs = require('fs');
const content = fs.readFileSync('/home/namansharma/Desktop/PROJECTS/extension/extension-src/playback.js', 'utf-8');
const match = content.match(/function extractSearchTermFromStep[\s\S]*?(?=^function|\Z)/m);
console.log(match ? match[0] : 'Not found');
