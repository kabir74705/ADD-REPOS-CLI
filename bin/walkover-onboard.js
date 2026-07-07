#!/usr/bin/env node

import { checkbox, input, confirm, password, select } from "@inquirer/prompts";
import chalk from "chalk";
import ora from "ora";
import { spawn, spawnSync } from "node:child_process";
import {
  access, mkdir, cp, rm, readdir, stat,
  copyFile, chmod, writeFile, readFile,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

// Central repo — only URL is fixed. The project folder inside it comes from the user.
const CENTRAL = {
  url: "https://github.com/kabir74705/CENTRAL_REPO",
  tmpName: "central-repo",
};

// IDEs the CLI knows how to configure code-review-graph for.
const SUPPORTED_IDES = [
  { value: "cursor",      name: "Cursor" },
  { value: "claude",      name: "Claude Code" },
  { value: "codex",       name: "Codex" },
  { value: "devin",       name: "Devin" },
  { value: "copilot",     name: "GitHub Copilot (VS Code)" },
  { value: "antigravity", name: "Antigravity" },
];

// ─── helpers ────────────────────────────────────────────────────────────────

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
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (err) => reject(new Error(`Failed to run git: ${err.message}`)));
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `git exited with code ${code}`));
    });
  });
}

async function pathExists(target) {
  try { await access(target); return true; }
  catch { return false; }
}

async function ensureGitInstalled() {
  try { await runGit(["--version"], process.cwd()); }
  catch {
    console.error(
      chalk.red("\n  Git is not installed or not available in PATH.\n") +
      chalk.dim("  Install Git from https://git-scm.com/ and try again.\n")
    );
    process.exit(1);
  }
}

// ─── central repo ────────────────────────────────────────────────────────────

// Clone central repo into a temp folder inside parentDir.
async function cloneCentralRepo(parentDir) {
  const dest = path.join(parentDir, CENTRAL.tmpName);
  await rm(dest, { recursive: true, force: true });
  await runGit(["clone", "--depth", "1", CENTRAL.url, CENTRAL.tmpName], parentDir);
  return dest;
}

// List top-level project roots in the central repo (gtwy, viasocket, docstar, …).
async function listProjectRoots(centralRepoPath) {
  const entries = await readdir(centralRepoPath);
  const roots = [];
  for (const entry of entries) {
    if (entry === "IDEconfig" || entry.startsWith(".")) continue;
    const abs = path.join(centralRepoPath, entry);
    const info = await stat(abs);
    if (info.isDirectory()) roots.push(entry);
  }
  return roots.sort();
}

// Read repos from CENTRAL_REPO/<project>/<repo>/config.js.
// Each subfolder under the project root must have a config.js with { repoUrl, envs }.
async function readReposFromProjectRoot(centralRepoPath, project) {
  const projectDir = path.join(centralRepoPath, project);
  if (!(await pathExists(projectDir))) return [];

  const entries = await readdir(projectDir);
  const repos = [];

  for (const entry of entries) {
    const repoDir = path.join(projectDir, entry);
    const info = await stat(repoDir);
    if (!info.isDirectory()) continue;

    const configFile = path.join(repoDir, "config.js");
    if (!(await pathExists(configFile))) continue;

    try {
      const mod = await import(pathToFileURL(configFile).href);
      const cfg = mod.default;
      if (!cfg?.repoUrl) continue;
      repos.push({
        name: entry,
        url: cfg.repoUrl,
        envs: cfg.envs || {},
        description: cfg.description || entry,
      });
    } catch {
      // skip malformed config
    }
  }

  return repos.sort((a, b) => a.name.localeCompare(b.name));
}

// ─── per-repo helpers ────────────────────────────────────────────────────────

async function cloneRepo(repo, targetDir) {
  const dest = path.join(targetDir, repo.name);
  if (await pathExists(dest)) throw new Error(`Directory already exists: ${dest}`);
  await runGit(["clone", repo.url, repo.name], targetDir);
  return dest;
}

async function listFilesRecursive(dir, base = dir) {
  const out = [];
  let entries;
  try { entries = await readdir(dir); } catch { return out; }
  for (const entry of entries) {
    const abs = path.join(dir, entry);
    const info = await stat(abs);
    if (info.isDirectory()) out.push(...(await listFilesRecursive(abs, base)));
    else out.push(path.relative(base, abs).split(path.sep).join("/"));
  }
  return out;
}

// Copy docs from CENTRAL_REPO/<project>/<repoName>/ into the cloned repo.
async function copyDocsFromCentral(centralRepoPath, project, repoName, repoDir) {
  const source = path.join(centralRepoPath, project, repoName);
  if (!(await pathExists(source))) return [];
  const copied = await listFilesRecursive(source);
  await cp(source, repoDir, { recursive: true });
  return copied;
}

// Generate a .env file from the repo's config envs (keys only, empty values).
async function generateEnvFile(repoDir, envs) {
  if (!envs || Object.keys(envs).length === 0) return;
  const lines = ["# Auto-generated by walkover-onboard — fill in values before running", ""];
  for (const [key, val] of Object.entries(envs)) {
    lines.push(`${key}=${val}`);
  }
  const envPath = path.join(repoDir, ".env.example");
  await writeFile(envPath, lines.join("\n") + "\n", "utf8");
}

// Install MCP config for the chosen IDE from IDEconfig/<ide>/mcpsConfig.js.
async function installCodeGraphMcp(clonedPath, ide, centralRepoPath) {
  const mcpConfigFile = path.join(centralRepoPath, "IDEconfig", ide, "mcpsConfig.js");
  if (!(await pathExists(mcpConfigFile))) return null;

  const mod = await import(pathToFileURL(mcpConfigFile).href);
  const { path: targetRelPath, format } = mod.default;
  const patchedFormat = patchMcpFormatForRunner(format);

  const targetPath = path.join(clonedPath, targetRelPath);
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, JSON.stringify(patchedFormat, null, 2) + "\n", "utf8");
  return targetRelPath;
}

// ─── code-review-graph ───────────────────────────────────────────────────────

// How to invoke code-review-graph on this machine (cached after first resolve).
let codeReviewGraphRunner = null;

function tryRunner(command, baseArgs, probeArgs) {
  const res = spawnSync(command, [...baseArgs, ...probeArgs], {
    encoding: "utf8",
    stdio: "pipe",
  });
  if (!res.error && res.status === 0) {
    return { command, baseArgs };
  }
  return null;
}

// Direct CLI is often missing from PATH on Windows even after pip install.
// Fall back to: python -m code_review_graph
function resolveCodeReviewGraphRunner() {
  if (codeReviewGraphRunner) return codeReviewGraphRunner;

  const candidates = [
    ["code-review-graph", [], ["-v"]],
    ["python", ["-m", "code_review_graph"], ["-v"]],
    ["python3", ["-m", "code_review_graph"], ["-v"]],
  ];

  for (const [command, baseArgs, probeArgs] of candidates) {
    const runner = tryRunner(command, baseArgs, probeArgs);
    if (runner) {
      codeReviewGraphRunner = runner;
      return runner;
    }
  }
  return null;
}

function runCodeReviewGraph(subcommand, extraArgs = [], cwd) {
  const runner = resolveCodeReviewGraphRunner();
  if (!runner) return { ok: false, detail: "code-review-graph not available" };

  const res = spawnSync(runner.command, [...runner.baseArgs, subcommand, ...extraArgs], {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
  });
  if (!res.error && res.status === 0) {
    return { ok: true };
  }
  return {
    ok: false,
    detail: (res.stderr || res.stdout || res.error?.message || "command failed").trim(),
  };
}

// Try pip / pip3 / python -m pip until one works.
function runPipInstall(packageName) {
  const attempts = [
    ["pip", ["install", packageName]],
    ["pip3", ["install", packageName]],
    ["python", ["-m", "pip", "install", packageName]],
    ["python3", ["-m", "pip", "install", packageName]],
  ];

  let lastDetail = "pip not found";
  for (const [cmd, args] of attempts) {
    const res = spawnSync(cmd, args, { encoding: "utf8", stdio: "pipe" });
    if (res.error) continue;
    if (res.status === 0) {
      return { ok: true, via: `${cmd} ${args.join(" ")}` };
    }
    lastDetail = (res.stderr || res.stdout || `${cmd} exited with ${res.status}`).trim();
  }
  return { ok: false, detail: lastDetail };
}

// Install code-review-graph once if missing (fail-open).
function ensureCodeReviewGraphInstalled() {
  const existing = resolveCodeReviewGraphRunner();
  if (existing) {
    const via =
      existing.command === "code-review-graph"
        ? "code-review-graph"
        : `${existing.command} ${existing.baseArgs.join(" ")}`;
    return { installed: true, alreadyHad: true, via };
  }

  const pipResult = runPipInstall("code-review-graph");
  if (!pipResult.ok) {
    return { installed: false, error: pipResult.detail };
  }

  // Re-resolve — pip may install the package but not put the script on PATH.
  codeReviewGraphRunner = null;
  const runner = resolveCodeReviewGraphRunner();
  if (runner) {
    const via =
      runner.command === "code-review-graph"
        ? pipResult.via
        : `${runner.command} ${runner.baseArgs.join(" ")} (via ${pipResult.via})`;
    return { installed: true, alreadyHad: false, via };
  }

  return {
    installed: false,
    error: "pip install finished but code-review-graph could not be run",
  };
}

function buildCodeGraph(repoDir) {
  return runCodeReviewGraph("build", [], repoDir).ok;
}

// Patch MCP config to use python -m when the direct CLI is not on PATH.
function patchMcpFormatForRunner(format) {
  const runner = resolveCodeReviewGraphRunner();
  if (!runner || runner.command === "code-review-graph") return format;

  const patched = structuredClone(format);
  const server = patched.mcpServers?.["code-review-graph"];
  if (server) {
    server.command = runner.command;
    server.args = [...runner.baseArgs, "serve"];
  }
  return patched;
}

// ─── token + hooks ───────────────────────────────────────────────────────────

// Save config to ~/.walkover/config.json (token + project, merged with any existing values).
async function saveWalkoverConfig(updates) {
  const walkoverDir = path.join(os.homedir(), ".walkover");
  await mkdir(walkoverDir, { recursive: true });
  const configPath = path.join(walkoverDir, "config.json");

  let existing = {};
  try {
    const raw = await readFile(configPath, "utf8");
    existing = JSON.parse(raw);
  } catch { }

  await writeFile(configPath, JSON.stringify({ ...existing, ...updates }, null, 2), "utf8");
  try { await chmod(configPath, 0o600); } catch { }
}

async function installGlobalRunner() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const runnerSrc = path.join(here, "..", "hooks", "sync-docs.mjs");
  const walkoverDir = path.join(os.homedir(), ".walkover");
  await mkdir(walkoverDir, { recursive: true });
  await copyFile(runnerSrc, path.join(walkoverDir, "sync-docs.mjs"));
}

async function installRepoHook(repoDir) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const hookSrc = path.join(here, "..", "hooks", "post-commit");
  const hooksDir = path.join(repoDir, ".git", "hooks");
  await mkdir(hooksDir, { recursive: true });
  const hookDest = path.join(hooksDir, "post-commit");
  await copyFile(hookSrc, hookDest);
  try { await chmod(hookDest, 0o755); } catch { }
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  printBanner();
  await ensureGitInstalled();

  // 1. Ask where to put all the cloned repos.
  const defaultParent = path.join(process.cwd(), "walkover-repos");
  const parentInput = await input({
    message: "Parent folder (all repos will be cloned inside it):",
    default: defaultParent,
  });
  const parentDir = path.resolve(parentInput.trim() || defaultParent);

  await mkdir(parentDir, { recursive: true });

  // 2. Clone central repo first so we can list project roots and repo configs.
  let centralRepoPath = null;

  const centralSpinner = ora("Cloning central repo...").start();
  try {
    centralRepoPath = await cloneCentralRepo(parentDir);
    centralSpinner.succeed("Cloned central repo");
  } catch (err) {
    centralSpinner.fail(`Could not clone central repo: ${err.message}`);
    console.log(chalk.red("\n  Cannot continue without the central repo.\n"));
    process.exit(1);
  }

  // 3. Ask which project root folder to use (gtwy, viasocket, docstar, …).
  const projectRoots = await listProjectRoots(centralRepoPath);
  let project;

  if (projectRoots.length > 0) {
    project = await select({
      message: "Which project are you working on?",
      choices: projectRoots.map((name) => ({ name, value: name })),
    });
  } else {
    const projectInput = await input({
      message: "Which project are you working on? (e.g. gtwy, viasocket, docstar):",
    });
    project = projectInput.trim();
    if (!project) {
      console.log(chalk.red("\n  Project name cannot be empty.\n"));
      process.exit(1);
    }
  }

  const availableRepos = await readReposFromProjectRoot(centralRepoPath, project);

  if (availableRepos.length === 0) {
    console.log(
      chalk.red(
        `\n  No repos with config.js found under ${project}/ in the central repo.\n` +
        chalk.dim(`  Expected: CENTRAL_REPO/${project}/<repo-name>/config.js\n`)
      )
    );
    await rm(centralRepoPath, { recursive: true, force: true });
    process.exit(1);
  }

  console.log(
    chalk.dim(
      `\n  Found ${availableRepos.length} repo(s) under ${chalk.cyan(project)}/ in central repo\n`
    )
  );

  // 4. Ask which repos to clone.
  const selectedNames = await checkbox({
    message: "Select the repos you need:",
    choices: availableRepos.map((repo) => ({
      name: repo.name,
      value: repo.name,
      description: repo.url,
      short: repo.name,
    })),
    pageSize: 10,
    loop: false,
  });

  const selectedRepos = availableRepos.filter((r) => selectedNames.includes(r.name));

  if (selectedRepos.length === 0) {
    console.log(chalk.dim("\n  No repos selected. Run again and press SPACE to select.\n"));
    process.exit(0);
  }

  // 5. Ask which IDE (for code graph MCP setup).
  const ide = await select({
    message: "Which IDE are you using? (for code graph setup):",
    choices: SUPPORTED_IDES,
  });

  // 6. Ask for GitHub token.
  const githubToken = await password({
    message: "GitHub token for doc-sync PRs (optional — press Enter to skip):",
    mask: "*",
  });

  // 7. Show summary and confirm.
  console.log();
  console.log(chalk.bold("  Summary"));
  console.log(`    Project  : ${chalk.cyan(project.trim())}`);
  console.log(`    IDE      : ${chalk.cyan(SUPPORTED_IDES.find((i) => i.value === ide)?.name)}`);
  console.log(`    Location : ${chalk.cyan(parentDir)}`);
  console.log(`    Repos    :`);
  for (const repo of selectedRepos) {
    console.log(`      ${chalk.green("•")} ${repo.name}`);
  }
  console.log();

  const proceed = await confirm({ message: "Proceed?", default: true });
  if (!proceed) {
    console.log(chalk.dim("\n  Cancelled.\n"));
    process.exit(0);
  }

  // 8. Save project + GitHub token to ~/.walkover/config.json.
  const configUpdates = { project: project.trim() };
  if (githubToken?.trim()) configUpdates.githubToken = githubToken.trim();

  const tokenSpinner = ora("Saving config (project + token)...").start();
  try {
    await saveWalkoverConfig(configUpdates);
    tokenSpinner.succeed(
      githubToken?.trim()
        ? "Saved project and GitHub token to ~/.walkover/config.json"
        : "Saved project name to ~/.walkover/config.json"
    );
  } catch (err) {
    tokenSpinner.warn(`Could not save config: ${err.message}`);
  }

  // 9. Install shared doc-sync runner once.
  const runnerSpinner = ora("Installing doc-sync runner...").start();
  let runnerInstalled = false;
  try {
    await installGlobalRunner();
    runnerInstalled = true;
    runnerSpinner.succeed("Installed doc-sync runner");
  } catch (err) {
    runnerSpinner.warn(`Could not install doc-sync runner: ${err.message}`);
  }

  const results = [];
  let codeGraphReady = false;

  // Install code-review-graph once (if missing) before building graphs per repo.
  const graphInstallSpinner = ora("Checking code-review-graph...").start();
  const graphInstall = ensureCodeReviewGraphInstalled();
  if (graphInstall.installed) {
    codeGraphReady = true;
    graphInstallSpinner.succeed(
      graphInstall.alreadyHad
        ? `code-review-graph ready (${graphInstall.via})`
        : `Installed code-review-graph via ${graphInstall.via}`
    );
  } else {
    graphInstallSpinner.warn(
      `Could not install code-review-graph: ${graphInstall.error}`
    );
  }

  try {
    for (const repo of selectedRepos) {
      // ── clone ──────────────────────────────────────────────────────────
      const spinner = ora(`Cloning ${chalk.cyan(repo.name)}...`).start();
      let clonedPath;
      try {
        clonedPath = await cloneRepo(repo, parentDir);
        spinner.succeed(`Cloned ${chalk.cyan(repo.name)} → ${clonedPath}`);
      } catch (err) {
        spinner.fail(`Failed to clone ${chalk.cyan(repo.name)}: ${err.message}`);
        results.push({ repo, success: false, error: err.message });
        continue;
      }

      // ── .env.example ───────────────────────────────────────────────────
      try {
        await generateEnvFile(clonedPath, repo.envs);
        console.log(chalk.dim(`    + .env.example`));
      } catch { }

      // ── docs from central ──────────────────────────────────────────────
      if (centralRepoPath) {
        const docsSpinner = ora({
          text: `Copying docs for ${chalk.cyan(repo.name)}...`,
          prefixText: "  ",
        }).start();
        try {
          const docs = await copyDocsFromCentral(
            centralRepoPath, project.trim(), repo.name, clonedPath
          );
          if (docs.length > 0) {
            docsSpinner.succeed(`Added ${docs.length} doc file(s) to ${chalk.cyan(repo.name)}`);
            for (const rel of docs) console.log(chalk.dim(`      + ${rel}`));
          } else {
            docsSpinner.warn(`No docs found for ${chalk.cyan(repo.name)} under ${project.trim()}/`);
          }
        } catch (err) {
          docsSpinner.fail(`Could not copy docs: ${err.message}`);
        }
      }

      // ── doc-sync hook ──────────────────────────────────────────────────
      if (runnerInstalled) {
        const hookSpinner = ora({
          text: `Installing doc-sync hook for ${chalk.cyan(repo.name)}...`,
          prefixText: "  ",
        }).start();
        try {
          await installRepoHook(clonedPath);
          hookSpinner.succeed(`Installed doc-sync hook for ${chalk.cyan(repo.name)}`);
        } catch (err) {
          hookSpinner.warn(`Could not install hook: ${err.message}`);
        }
      }

      // ── code graph MCP config ──────────────────────────────────────────
      if (centralRepoPath) {
        const mcpSpinner = ora({
          text: `Setting up code graph MCP for ${chalk.cyan(repo.name)} (${ide})...`,
          prefixText: "  ",
        }).start();
        try {
          const targetPath = await installCodeGraphMcp(clonedPath, ide, centralRepoPath);
          if (targetPath) {
            mcpSpinner.succeed(`MCP config written → ${targetPath}`);
          } else {
            mcpSpinner.warn(`No MCP config found for IDE: ${ide}`);
          }
        } catch (err) {
          mcpSpinner.warn(`Could not write MCP config: ${err.message}`);
        }
      }

      // ── code-review-graph build ────────────────────────────────────────
      const graphSpinner = ora({
        text: `Building code graph for ${chalk.cyan(repo.name)}...`,
        prefixText: "  ",
      }).start();
      if (!codeGraphReady) {
        graphSpinner.warn("Skipped code graph build (code-review-graph not installed)");
      } else {
        const graphBuilt = buildCodeGraph(clonedPath);
        if (graphBuilt) {
          graphSpinner.succeed(`Code graph built for ${chalk.cyan(repo.name)}`);
        } else {
          graphSpinner.warn(
            `code-review-graph build failed for ${chalk.cyan(repo.name)}`
          );
        }
      }

      results.push({ repo, success: true, path: clonedPath });
    }
  } finally {
    // ── workspace AGENTS.md ──────────────────────────────────────────────
    if (centralRepoPath) {
      const agentsSrc = path.join(centralRepoPath, project.trim(), "AGENTS.md");
      const agentsDest = path.join(parentDir, "AGENTS.md");
      

      // Remove temp central clone.
     
    }
  }

  // ── summary ───────────────────────────────────────────────────────────────
  console.log();
  const failed = results.filter((r) => !r.success);
  const succeeded = results.filter((r) => r.success);

  if (succeeded.length > 0) {
    console.log(chalk.bold.green(`  Done! ${succeeded.length} repo(s) cloned:\n`));
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
