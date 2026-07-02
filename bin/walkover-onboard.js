#!/usr/bin/env node

import { checkbox, input, confirm } from "@inquirer/prompts";
import chalk from "chalk";
import ora from "ora";
import { spawn } from "node:child_process";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const CENTRAL_REPO = {
  name: "gtwy-ai",
  url: "https://github.com/Walkover-Web-Solution/gtwy-ai",
  description: "Central repo (always included)",
  required: true,
};

const OPTIONAL_REPOS = [
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

const AGENTS_MD_CONTENT = `<!-- code-review-graph MCP tools -->
## MCP Tools: code-review-graph

**IMPORTANT: This project has a knowledge graph. ALWAYS use the
code-review-graph MCP tools BEFORE using Grep/Glob/Read to explore
the codebase.** The graph is faster, cheaper (fewer tokens), and gives
you structural context (callers, dependents, test coverage) that file
scanning cannot.

### When to use graph tools FIRST

- **Exploring code**: \`semantic_search_nodes\` or \`query_graph\` instead of Grep
- **Understanding impact**: \`get_impact_radius\` instead of manually tracing imports
- **Code review**: \`detect_changes\` + \`get_review_context\` instead of reading entire files
- **Finding relationships**: \`query_graph\` with callers_of/callees_of/imports_of/tests_for
- **Architecture questions**: \`get_architecture_overview\` + \`list_communities\`

Fall back to Grep/Glob/Read **only** when the graph doesn't cover what you need.

### Key Tools

| Tool | Use when |
|------|----------|
| \`detect_changes\` | Reviewing code changes — gives risk-scored analysis |
| \`get_review_context\` | Need source snippets for review — token-efficient |
| \`get_impact_radius\` | Understanding blast radius of a change |
| \`get_affected_flows\` | Finding which execution paths are impacted |
| \`query_graph\` | Tracing callers, callees, imports, tests, dependencies |
| \`semantic_search_nodes\` | Finding functions/classes by name or keyword |
| \`get_architecture_overview\` | Understanding high-level codebase structure |
| \`refactor_tool\` | Planning renames, finding dead code |

### Workflow

1. The graph auto-updates on file changes (via hooks).
2. Use \`detect_changes\` for code review.
3. Use \`get_affected_flows\` to understand impact.
4. Use \`query_graph\` pattern="tests_for" to check coverage.
`;

async function writeAgentsMd(repoDir) {
  const filePath = path.join(repoDir, "AGENTS.md");
  await writeFile(filePath, AGENTS_MD_CONTENT, "utf8");
}

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

async function main() {
  printBanner();
  await ensureGitInstalled();

  const selectedNames = await checkbox({
    message: "Select optional repos (gtwy-ai is always included):",
    choices: OPTIONAL_REPOS.map((repo) => ({
      name: repo.name,
      value: repo.name,
      description: repo.description,
      short: repo.name,
    })),
    pageSize: 10,
    loop: false,
  });

  const selectedOptional = OPTIONAL_REPOS.filter((repo) =>
    selectedNames.includes(repo.name)
  );

  if (selectedOptional.length === 0) {
    const onlyCentral = await confirm({
      message:
        "No optional repos selected. Continue with only gtwy-ai?",
      default: false,
    });
    if (!onlyCentral) {
      console.log(chalk.dim("\n  Cancelled. Run again and press SPACE to select repos.\n"));
      process.exit(0);
    }
  } else {
    console.log(
      chalk.dim(
        `\n  Optional repos selected: ${selectedOptional.map((r) => r.name).join(", ")}\n`
      )
    );
  }

  const reposToClone = [CENTRAL_REPO, ...selectedOptional];

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
  for (const repo of reposToClone) {
    const suffix = repo.required ? chalk.yellow(" (required)") : "";
    console.log(`    ${chalk.green("•")} ${repo.name}/${suffix}`);
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

  for (const repo of reposToClone) {
    const spinner = ora(`Cloning ${chalk.cyan(repo.name)} into parent folder...`).start();
    try {
      const clonedPath = await cloneRepo(repo, parentDir);
      spinner.succeed(`Cloned ${chalk.cyan(repo.name)} → ${clonedPath}`);

      const agentsSpinner = ora({ text: `Adding ${chalk.magenta("AGENTS.md")} to ${chalk.cyan(repo.name)}...`, prefixText: "  " }).start();
      await writeAgentsMd(clonedPath);
      agentsSpinner.succeed(`Added ${chalk.magenta("AGENTS.md")} → ${clonedPath}`);

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
