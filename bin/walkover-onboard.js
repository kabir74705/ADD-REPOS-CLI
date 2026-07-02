#!/usr/bin/env node

import { checkbox, input, confirm } from "@inquirer/prompts";
import chalk from "chalk";
import ora from "ora";
import { spawn } from "node:child_process";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

// All repos are optional and chosen by the user (gtwy-ai included).
const REPOS = [
  {
    name: "gtwy-ai",
    url: "https://github.com/Walkover-Web-Solution/gtwy-ai",
    description: "AI service",
  },
  {
    name: "gtwy-node",
    url: "https://github.com/Walkover-Web-Solution/gtwy-node",
    description: "Backend / Node gateway service",
  },
  {
    name: "gtwy-ui",
    url: "https://github.com/Walkover-Web-Solution/gtwy-ui",
    description: "Gateway UI frontend",
  },
  {
    name: "chatbot-ui",
    url: "https://github.com/Walkover-Web-Solution/chatbot-ui",
    description: "Chatbot UI frontend",
  },
];

// Central repo that holds per-repo markdown docs under `<root>/<repo-name>/`.
// This repo is NOT cloned — we only pull the relevant .md files from it.
const CENTRAL_DOCS = {
  owner: "kabir74705",
  repo: "CENTRAL_REPO",
  branch: "master",
  root: "gtwy",
};

function printBanner() {
  console.log();
  console.log(chalk.bold.cyan("  Walkover Onboarding CLI"));
  console.log(chalk.dim("  Clone the repos you need to get started"));
  console.log(
    chalk.dim("  Tip: ↑↓ to move  •  SPACE to select  •  ENTER to confirm\n")
  );
}

function runGit(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
    });

    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      reject(new Error(`Failed to run git: ${err.message}`));
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr.trim() || `git exited with code ${code}`));
      }
    });
  });
}

async function pathExists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function ensureGitInstalled() {
  try {
    await runGit(["--version"], process.cwd());
  } catch {
    console.error(
      chalk.red("\n  Git is not installed or not available in PATH.\n") +
        chalk.dim("  Install Git from https://git-scm.com/ and try again.\n")
    );
    process.exit(1);
  }
}

async function cloneRepo(repo, targetDir) {
  const dest = path.join(targetDir, repo.name);

  if (await pathExists(dest)) {
    throw new Error(`Directory already exists: ${dest}`);
  }

  await runGit(["clone", repo.url, repo.name], targetDir);
  return dest;
}

async function fetchGithubJson(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "walkover-onboard-cli",
      Accept: "application/vnd.github+json",
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status} ${res.statusText}`);
  }
  return res.json();
}

// Pull everything under `<root>/<repoName>/` from the central repo (AGENTS.md
// plus the docs/ folder) and mirror the same structure into the freshly cloned
// repo directory (adding new files or replacing existing).
async function copyDocsForRepo(repoName, repoDir) {
  const { owner, repo, branch, root } = CENTRAL_DOCS;

  // Resolve the branch tip, then read the full tree recursively so we pick up
  // nested folders (e.g. docs/) without walking the contents API level by level.
  const branchInfo = await fetchGithubJson(
    `https://api.github.com/repos/${owner}/${repo}/branches/${branch}`
  );
  const treeSha = branchInfo.commit.commit.tree.sha;
  const treeData = await fetchGithubJson(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${treeSha}?recursive=1`
  );

  const prefix = `${root}/${repoName}/`;
  const files = (treeData.tree || []).filter(
    (entry) => entry.type === "blob" && entry.path.startsWith(prefix)
  );

  const written = [];
  for (const file of files) {
    const relPath = file.path.slice(prefix.length);
    const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${file.path}`;

    const res = await fetch(rawUrl, {
      headers: { "User-Agent": "walkover-onboard-cli" },
    });
    if (!res.ok) {
      throw new Error(`Failed to download ${relPath}: ${res.status}`);
    }
    const content = await res.text();

    const dest = path.join(repoDir, relPath);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, content, "utf8");
    written.push(relPath);
  }
  return written;
}

async function main() {
  printBanner();
  await ensureGitInstalled();

  const selectedNames = await checkbox({
    message: "Select the repos you need:",
    choices: REPOS.map((repo) => ({
      name: repo.name,
      value: repo.name,
      description: repo.description,
      short: repo.name,
    })),
    pageSize: 10,
    loop: false,
  });

  const selectedRepos = REPOS.filter((repo) =>
    selectedNames.includes(repo.name)
  );

  if (selectedRepos.length === 0) {
    console.log(
      chalk.dim("\n  No repos selected. Run again and press SPACE to select.\n")
    );
    process.exit(0);
  }

  console.log(
    chalk.dim(
      `\n  Selected: ${selectedRepos.map((r) => r.name).join(", ")}\n`
    )
  );

  const defaultParent = path.join(process.cwd(), "walkover-repos");
  const parentInput = await input({
    message: "Parent folder (all selected repos will be cloned inside it):",
    default: defaultParent,
  });

  const parentDir = path.resolve(parentInput.trim() || defaultParent);

  console.log();
  console.log(chalk.bold("  All repos will live under:"));
  console.log(chalk.cyan(`    ${parentDir}`));
  console.log();
  console.log(chalk.bold("  Folder structure:"));
  for (const repo of selectedRepos) {
    console.log(`    ${chalk.green("•")} ${repo.name}/`);
  }
  console.log();

  const proceed = await confirm({
    message: "Proceed with cloning?",
    default: true,
  });

  if (!proceed) {
    console.log(chalk.dim("\n  Cancelled.\n"));
    process.exit(0);
  }

  await mkdir(parentDir, { recursive: true });

  const results = [];

  for (const repo of selectedRepos) {
    const spinner = ora(
      `Cloning ${chalk.cyan(repo.name)} into parent folder...`
    ).start();
    try {
      const clonedPath = await cloneRepo(repo, parentDir);
      spinner.succeed(`Cloned ${chalk.cyan(repo.name)} → ${clonedPath}`);

      const docsSpinner = ora({
        text: `Fetching docs for ${chalk.cyan(repo.name)} from central repo...`,
        prefixText: "  ",
      }).start();
      try {
        const docs = await copyDocsForRepo(repo.name, clonedPath);
        if (docs.length > 0) {
          docsSpinner.succeed(
            `Added ${docs.length} doc file(s) to ${chalk.cyan(repo.name)}`
          );
          for (const rel of docs) {
            console.log(chalk.dim(`      + ${rel}`));
          }
        } else {
          docsSpinner.warn(
            `No docs found for ${chalk.cyan(repo.name)} in central repo`
          );
        }
      } catch (docErr) {
        docsSpinner.fail(
          `Could not fetch docs for ${chalk.cyan(repo.name)}: ${docErr.message}`
        );
      }

      results.push({ repo, success: true, path: clonedPath });
    } catch (err) {
      spinner.fail(`Failed to clone ${chalk.cyan(repo.name)}`);
      results.push({ repo, success: false, error: err.message });
    }
  }

  console.log();
  const failed = results.filter((r) => !r.success);
  const succeeded = results.filter((r) => r.success);

  if (succeeded.length > 0) {
    console.log(
      chalk.bold.green(
        `  Done! ${succeeded.length} repo(s) cloned into parent folder:\n`
      )
    );
    console.log(chalk.cyan(`    ${parentDir}`));
    console.log();
    for (const { repo } of succeeded) {
      console.log(chalk.dim(`    ├── ${repo.name}/`));
    }
    console.log();
    console.log(chalk.dim(`  Start here: cd ${parentDir}\n`));
  }

  if (failed.length > 0) {
    console.log(chalk.bold.red(`  ${failed.length} repo(s) failed:\n`));
    for (const { repo, error } of failed) {
      console.log(`    ${chalk.red("✗")} ${repo.name}: ${error}`);
    }
    console.log();
    process.exit(1);
  }
}

main().catch((err) => {
  if (err.name === "ExitPromptError") {
    console.log(chalk.dim("\n  Cancelled.\n"));
    process.exit(0);
  }
  console.error(chalk.red(`\n  Error: ${err.message}\n`));
  process.exit(1);
});
