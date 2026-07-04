#!/usr/bin/env node
// sync-docs.mjs
// Installed to ~/.walkover/sync-docs.mjs and invoked by each project repo's
// .git/hooks/post-commit hook.
//
// On every commit it:
//   1. finds the doc files changed in that commit (AGENTS.md + docs/**)
//   2. updates a local clone of the central repo with those changes
//   3. pushes a branch and opens a PR on the actual central repo
//
// Auth:
//   - git push  → uses the developer's existing git credentials
//   - PR create → uses the GitHub REST API with the token the CLI saved to
//                 ~/.walkover/config.json (falls back to the GITHUB_TOKEN env var)
//
// It NEVER fails the developer's commit — any error just skips the sync.

import { spawnSync } from "node:child_process";
import { mkdir, copyFile, access } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const CENTRAL = {
  owner: "kabir74705",
  repo: "CENTRAL_REPO",
  url: "https://github.com/kabir74705/CENTRAL_REPO",
  base: "master",
  root: "gtwy",
};

// Which committed paths count as docs that mirror into the central repo.
const DOC_ROOTS = ["AGENTS.md", "docs/"];

const CENTRAL_CLONE = path.join(os.homedir(), ".walkover", "CENTRAL_REPO");

// Read the GitHub token the CLI saved to ~/.walkover/config.json.
// Falls back to the GITHUB_TOKEN env var if the config file isn't present.
function loadGithubToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    const configPath = path.join(os.homedir(), ".walkover", "config.json");
    const cfg = JSON.parse(readFileSync(configPath, "utf8"));
    return cfg.githubToken || null;
  } catch {
    return null;
  }
}

const GITHUB_TOKEN = loadGithubToken();

function git(args, cwd) {
  // No shell: true — with a shell on Windows, arguments containing spaces
  // (like the commit message) get split into separate tokens. Git is a normal
  // executable on PATH, so spawnSync resolves it fine without a shell.
  const res = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
  });
  if (res.error) {
    throw new Error(`git ${args.join(" ")} failed: ${res.error.message}`);
  }
  if (res.status !== 0) {
    const detail = (res.stderr || res.stdout || "").trim();
    throw new Error(`git ${args.join(" ")} failed: ${detail}`);
  }
  return (res.stdout || "").trim();
}

async function pathExists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

// Project name from the origin remote URL, e.g. ".../gtwy-node.git" -> "gtwy-node".
function getProjectName(cwd) {
  const url = git(["remote", "get-url", "origin"], cwd);
  return url.replace(/\.git$/, "").split(/[/:]/).pop();
}

// Doc files changed in the just-created commit (HEAD).
function getChangedDocFiles(cwd) {
  const out = git(
    ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"],
    cwd
  );
  return out
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean)
    .filter((f) => DOC_ROOTS.some((root) => f === root || f.startsWith(root)));
}

// Ensure a clean, up-to-date local clone of the central repo.
async function refreshCentralClone() {
  if (await pathExists(path.join(CENTRAL_CLONE, ".git"))) {
    git(["fetch", "origin"], CENTRAL_CLONE);
    git(["checkout", CENTRAL.base], CENTRAL_CLONE);
    git(["reset", "--hard", `origin/${CENTRAL.base}`], CENTRAL_CLONE);
    git(["clean", "-fd"], CENTRAL_CLONE);
  } else {
    await mkdir(path.dirname(CENTRAL_CLONE), { recursive: true });
    git(["clone", CENTRAL.url, CENTRAL_CLONE], os.homedir());
  }
}

async function createPullRequest(branch, project, files) {
  if (!GITHUB_TOKEN) {
    console.log(
      `  [walkover] Branch pushed. Set GITHUB_TOKEN to auto-open the PR.\n` +
        `  Open it manually: ${CENTRAL.url}/compare/${CENTRAL.base}...${branch}?expand=1`
    );
    return null;
  }

  const res = await fetch(
    `https://api.github.com/repos/${CENTRAL.owner}/${CENTRAL.repo}/pulls`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "walkover-sync-docs",
      },
      body: JSON.stringify({
        title: `docs(${project}): sync doc changes from latest commit`,
        head: branch,
        base: CENTRAL.base,
        body:
          `Automated documentation sync for **${project}**.\n\n` +
          `Files updated:\n` +
          files.map((f) => `- \`${f}\``).join("\n"),
      }),
    }
  );

  if (!res.ok) {
    throw new Error(`PR create failed: ${res.status} ${await res.text()}`);
  }
  const pr = await res.json();
  return pr.html_url;
}

async function main() {
  const projectDir = process.cwd();

  const changed = getChangedDocFiles(projectDir);
  if (changed.length === 0) {
    return; // no doc changes in this commit — nothing to sync
  }

  const project = getProjectName(projectDir);
  console.log(`  [walkover] Syncing ${changed.length} doc change(s) for ${project}...`);

  // Step 2: update the local central clone with those changes.
  await refreshCentralClone();

  const branch = `docs/${project}/${Date.now()}`;
  git(["checkout", "-b", branch], CENTRAL_CLONE);

  for (const rel of changed) {
    const src = path.join(projectDir, rel);
    const dest = path.join(CENTRAL_CLONE, CENTRAL.root, project, rel);
    await mkdir(path.dirname(dest), { recursive: true });
    await copyFile(src, dest);
  }

  git(["add", "-A"], CENTRAL_CLONE);

  const pending = git(["status", "--porcelain"], CENTRAL_CLONE);
  if (!pending) {
    console.log(
      `  [walkover] Docs already match ${CENTRAL.repo} — no PR needed.`
    );
    return;
  }

  git(
    ["commit", "-m", `docs(${project}): sync doc changes from latest commit`],
    CENTRAL_CLONE
  );

  // Step 3: push the branch and open a PR on the actual central repo.
  git(["push", "origin", branch], CENTRAL_CLONE);
  const prUrl = await createPullRequest(branch, project, changed);

  if (prUrl) {
    console.log(`  [walkover] Docs PR opened: ${prUrl}`);
  }
}

main().catch((err) => {
  // Never break the developer's commit.
  console.error(`  [walkover] Doc sync skipped: ${err.message}`);
  process.exit(0);
});
