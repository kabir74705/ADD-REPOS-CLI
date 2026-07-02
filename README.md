# Walkover Onboarding CLI

Interactive CLI for new Walkover hires to clone the company repos they need.

**Always cloned:** [gtwy-ai](https://github.com/Walkover-Web-Solution/gtwy-ai) (central repo)

**Optional:**

| Repo | Description |
|------|-------------|
| [gtwy-node](https://github.com/Walkover-Web-Solution/gtwy-node) | Backend / Node gateway |
| [gtwy-ui](https://github.com/Walkover-Web-Solution/gtwy-ui) | Gateway UI |
| [chatbot-ui](https://github.com/Walkover-Web-Solution/chatbot-ui) | Chatbot UI |

## Requirements

- [Node.js](https://nodejs.org/) 18+
- [Git](https://git-scm.com/)

## Install & run

```bash
cd walkover-onboard
npm install
npm start
```

Or link it globally:

```bash
npm install -g .
walkover-onboard
```

## What it does

1. Shows a checklist of optional repos (use Space to select, Enter to confirm)
2. Always includes `gtwy-ai`
3. Asks for a **parent folder** — every selected repo is cloned as a subfolder inside it
4. Clones everything with progress output

## Folder layout

All repos end up as siblings under one parent folder:

```
walkover-repos/          ← parent folder you choose
├── gtwy-ai/             ← always included
├── gtwy-node/           ← if selected
├── gtwy-ui/             ← if selected
└── chatbot-ui/          ← if selected
```

## Example

```
  Walkover Onboarding CLI
  Clone the repos you need to get started

? Select the repos you need (gtwy-ai is always included):
  ◯ gtwy-node — Backend / Node gateway service
  ◉ gtwy-ui — Gateway UI frontend
  ◯ chatbot-ui — Chatbot UI frontend

? Parent folder (all selected repos will be cloned inside it): ./walkover-repos

  All repos will live under:
    C:\Users\you\walkover-repos

  Folder structure:
    • gtwy-ai/ (required)
    • gtwy-ui/

? Proceed with cloning? Yes

✔ Cloned gtwy-ai → C:\Users\you\walkover-repos\gtwy-ai
✔ Cloned gtwy-ui → C:\Users\you\walkover-repos\gtwy-ui

  Done! 2 repo(s) cloned into parent folder:

    C:\Users\you\walkover-repos

    ├── gtwy-ai/
    ├── gtwy-ui/

  Start here: cd C:\Users\you\walkover-repos
```
