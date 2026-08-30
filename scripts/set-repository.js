#!/usr/bin/env node
// Fills the GitHub repository into every place that must know it: the updater
// endpoint (auto-updates) and the README badges. Run once after creating the repo:
//   node scripts/set-repository.js owner/repo
import { readFile, writeFile } from "node:fs/promises";

const slug = process.argv[2];
if (!slug || !/^[\w.-]+\/[\w.-]+$/.test(slug)) {
  console.error("Usage: node scripts/set-repository.js owner/repo");
  process.exit(1);
}
const [owner, repo] = slug.split("/");
const configPath = new URL("../apps/admin-desktop/src-tauri/tauri.conf.json", import.meta.url);
const readmePath = new URL("../README.md", import.meta.url);

const config = JSON.parse(await readFile(configPath, "utf8"));
const endpoint = `https://github.com/${slug}/releases/latest/download/latest.json`;
config.plugins.updater.endpoints = [endpoint];
await writeFile(configPath, JSON.stringify(config, null, 2) + "\n");

let readme = await readFile(readmePath, "utf8");
readme = readme.replaceAll("OWNER/REPO", slug).replaceAll("OWNER", owner).replaceAll("REPO", repo);
await writeFile(readmePath, readme);

console.log(`Repository set to ${slug}`);
console.log(`Updater endpoint: ${endpoint}`);
console.log("Rebuild the app so installed copies check the right address: npm run admin:build");
