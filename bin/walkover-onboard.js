#!/usr/bin/env node

import { checkbox, input, confirm, password } from "@inquirer/prompts";
import chalk from "chalk";
import ora from "ora";
import { spawn } from "node:child_process";
import { access, mkdir, cp, rm, readdir, stat, copyFile, chmod, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

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

// Central repo that holds per-repo docs under `<root>/<repo-name>/`.
// It is cloned in full first, then the relevant project's docs are copied
// from the local clone into each project repo. The clone is removed afterward.
const CENTRAL = {
  url: "https://github.com/kabir74705/CENTRAL_REPO",
  root: "gtwy",
  tmpName: "central-repo",
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

// Clone the whole central repo into a temporary folder and return its path.
async function cloneCentralRepo(parentDir) {
  const dest = path.join(parentDir, CENTRAL.tmpName);
  await rm(dest, { recursive: true, force: true });
  await runGit(["clone", "--depth", "1", CENTRAL.url, CENTRAL.tmpName], parentDir);
  return dest;
}

// List all files under `dir`, returned as paths relative to `dir`
// (forward-slash separated), so we can report what was copied.
async function listFilesRecursive(dir, base = dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry);
    const info = await stat(abs);
    if (info.isDirectory()) {
      out.push(...(await listFilesRecursive(abs, base)));
    } else {
      out.push(path.relative(base, abs).split(path.sep).join("/"));
    }
  }
  return out;
}

// Copy everything under `<central>/<root>/<repoName>/` (AGENTS.md plus the
// docs/ folder) from the local central clone into the project repo directory.
async function copyDocsFromCentral(centralRepoPath, repoName, repoDir) {
  const source = path.join(centralRepoPath, CENTRAL.root, repoName);

  if (!(await pathExists(source))) {
    return [];
  }

  const copied = await listFilesRecursive(source);
  await cp(source, repoDir, { recursive: true });
  return copied;
}

// Save the developer's GitHub token to ~/.walkover/config.json so the
// doc-sync runner can read it at commit time (used to open PRs).
async function saveGithubToken(token) {
  const walkoverDir = path.join(os.homedir(), ".walkover");
  await mkdir(walkoverDir, { recursive: true });
  const configPath = path.join(walkoverDir, "config.json");
  await writeFile(
    configPath,
    JSON.stringify({ githubToken: token }, null, 2),
    "utf8"
  );
  try {
    await chmod(configPath, 0o600); // readable only by the user (best-effort)
  } catch {
    // permissions may not apply on Windows — ignore.
  }
}

// Install the shared doc-sync runner once, in the user's home
// (~/.walkover/sync-docs.mjs). All repos' hooks call this single copy.
async function installGlobalRunner() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const runnerSrc = path.join(here, "..", "hooks", "sync-docs.mjs");

  const walkoverDir = path.join(os.homedir(), ".walkover");
  await mkdir(walkoverDir, { recursive: true });
  await copyFile(runnerSrc, path.join(walkoverDir, "sync-docs.mjs"));
}

// Install the post-commit hook into a single cloned repo. The hook just
// calls the shared runner installed by installGlobalRunner().
async function installRepoHook(repoDir) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const hookSrc = path.join(here, "..", "hooks", "post-commit");

  const hooksDir = path.join(repoDir, ".git", "hooks");
  await mkdir(hooksDir, { recursive: true });
  const hookDest = path.join(hooksDir, "post-commit");
  await copyFile(hookSrc, hookDest);
  try {
    await chmod(hookDest, 0o755);
  } catch {
    // chmod is a no-op / may fail on Windows — the hook still runs via sh.
  }
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

  const githubToken = await password({
    message:
      "GitHub token for doc-sync PRs (optional — press Enter to skip):",
    mask: "*",
  });

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

  // Save the GitHub token (if provided) so the doc-sync runner can open PRs.
  if (githubToken && githubToken.trim()) {
    const tokenSpinner = ora("Saving GitHub token...").start();
    try {
      await saveGithubToken(githubToken.trim());
      tokenSpinner.succeed(
        `Saved GitHub token → ${path.join(os.homedir(), ".walkover", "config.json")}`
      );
    } catch (tokenErr) {
      tokenSpinner.warn(`Could not save GitHub token: ${tokenErr.message}`);
    }
  } else {
    console.log(
      chalk.dim(
        "  No GitHub token provided — doc-sync PRs will need a manual link.\n"
      )
    );
  }

  // Step 1: clone the entire central repo first (used as the docs source).
  let centralRepoPath = null;
  const centralSpinner = ora("Cloning central repo (docs source)...").start();
  try {
    centralRepoPath = await cloneCentralRepo(parentDir);
    centralSpinner.succeed("Cloned central repo (docs source)");
  } catch (err) {
    centralSpinner.fail(`Could not clone central repo: ${err.message}`);
    console.log(chalk.dim("  Docs will be skipped for all repos.\n"));
  }

  // Install the shared doc-sync runner once (not per repo).
  const runnerSpinner = ora("Installing doc-sync runner (once)...").start();
  let runnerInstalled = false;
  try {
    await installGlobalRunner();
    runnerInstalled = true;
    runnerSpinner.succeed("Installed doc-sync runner");
  } catch (runnerErr) {
    runnerSpinner.warn(
      `Could not install doc-sync runner: ${runnerErr.message} (hooks will be skipped)`
    );
  }

  const results = [];

  try {
    // Step 2: clone each selected repo, then copy its docs from the central clone.
    for (const repo of selectedRepos) {
      const spinner = ora(
        `Cloning ${chalk.cyan(repo.name)} into parent folder...`
      ).start();
      try {
        const clonedPath = await cloneRepo(repo, parentDir);
        spinner.succeed(`Cloned ${chalk.cyan(repo.name)} → ${clonedPath}`);

        if (centralRepoPath) {
          const docsSpinner = ora({
            text: `Copying docs for ${chalk.cyan(repo.name)} from central repo...`,
            prefixText: "  ",
          }).start();
          try {
            const docs = await copyDocsFromCentral(
              centralRepoPath,
              repo.name,
              clonedPath
            );
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
              `Could not copy docs for ${chalk.cyan(repo.name)}: ${docErr.message}`
            );
          }
        }

        if (runnerInstalled) {
          const hookSpinner = ora({
            text: `Installing doc-sync hook for ${chalk.cyan(repo.name)}...`,
            prefixText: "  ",
          }).start();
          try {
            await installRepoHook(clonedPath);
            hookSpinner.succeed(`Installed doc-sync hook for ${chalk.cyan(repo.name)}`);
          } catch (hookErr) {
            hookSpinner.warn(
              `Could not install doc-sync hook for ${chalk.cyan(repo.name)}: ${hookErr.message}`
            );
          }
        }

        results.push({ repo, success: true, path: clonedPath });
      } catch (err) {
        spinner.fail(`Failed to clone ${chalk.cyan(repo.name)}`);
        results.push({ repo, success: false, error: err.message });
      }
    }
  } finally {
    // Step 3: copy the workspace-level AGENTS.md (CENTRAL_REPO/gtwy/AGENTS.md → walkover-repos/AGENTS.md).
    if (centralRepoPath) {
      const globalAgentsSrc = path.join(centralRepoPath, CENTRAL.root, "AGENTS.md");
      const globalAgentsDest = path.join(parentDir, "AGENTS.md");
      const agentsSpinner = ora("Copying workspace AGENTS.md...").start();
      try {
        if (await pathExists(globalAgentsSrc)) {
          await copyFile(globalAgentsSrc, globalAgentsDest);
          agentsSpinner.succeed(
            `Copied workspace AGENTS.md → ${chalk.cyan(globalAgentsDest)}`
          );
        } else {
          agentsSpinner.warn("No global AGENTS.md found in central repo (skipped)");
        }
      } catch (agentsErr) {
        agentsSpinner.warn(`Could not copy workspace AGENTS.md: ${agentsErr.message}`);
      }

      // Remove the temporary central clone.
      
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
