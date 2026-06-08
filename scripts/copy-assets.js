#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');

function copyFile(relativePath) {
  const src = path.join(root, 'src', relativePath);
  const dest = path.join(dist, relativePath);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  console.log(`Copied ${relativePath} -> dist/${relativePath}`);
}

copyFile('data/knowledge_items.json');
copyFile('db/schema.sql');
