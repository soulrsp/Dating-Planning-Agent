// Copies ONLY the files the app needs into .hosting-dist/ and deploys that folder to Firebase Hosting.
//
// Whitelist on purpose, not "deploy everything except...": this directory also holds secrets/,
// API 모음.txt, txt debug/, .venv/, backup/ and archive/. GitHub Pages only ever saw committed files,
// but `firebase deploy` uploads whatever is in its public folder, so the public folder must be built
// from an explicit list — a new secrets file can never leak by being forgotten in an ignore list.
//
//   node deploy-hosting.js              build .hosting-dist/ and deploy
//   node deploy-hosting.js --no-deploy  build .hosting-dist/ only (to inspect what would be uploaded)

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = __dirname;
const DIST = path.join(ROOT, ".hosting-dist");
const FILES = ["index.html", "app.js", "style.css", "sw.js", "manifest.json"];
const DIRS = ["images"];

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST);

for (const f of FILES) {
    fs.copyFileSync(path.join(ROOT, f), path.join(DIST, f));
}
for (const d of DIRS) {
    fs.cpSync(path.join(ROOT, d), path.join(DIST, d), { recursive: true });
}

const listed = [];
(function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else listed.push(path.relative(DIST, full).replace(/\\/g, "/"));
    }
})(DIST);
console.log("Files to be deployed:\n  " + listed.join("\n  "));

if (process.argv.includes("--no-deploy")) process.exit(0);

const result = spawnSync("npx", ["--yes", "firebase-tools", "deploy", "--only", "hosting"], {
    cwd: ROOT,
    stdio: "inherit",
    shell: true
});
process.exit(result.status === null ? 1 : result.status);
