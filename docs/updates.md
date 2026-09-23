# Plugin updates

Unison updates itself from the repository and branch configured at the top of
`main.js`:

```js
const UPDATE_REPO = 'https://raw.githubusercontent.com/iluha067/Unison/main';
```

- A **background check** (shortly after startup and every 6 hours) only
  *notifies* that a newer version is available. It never installs on its own.
- A **manual check** (**Settings -> Unison -> Check for update**, or the command
  palette) downloads `manifest.json`, `main.js` and `styles.css`, writes them
  into the plugin folder and reloads Obsidian.

## Public repository (default)

This repository is public, so updates need no configuration. Files are fetched
from the raw CDN with a cache-buster (`?t=<timestamp>`).

## Private repository (optional)

If you fork this into a private repository, the raw CDN will not serve it. Set a
GitHub token and Unison will use the GitHub Contents API instead:

1. Open **Settings -> Unison**.
2. Paste a token into **"Update token (private repo)"**.
3. Press **Check for update**.

Use a fine-grained token with **Contents: Read** on the repository (or a classic
token with the `repo` scope).

Note: the token is stored in plain text in the plugin's `data.json`, because
Obsidian has no secret store. Prefer a read-only, repository-scoped token.

## Installing via BRAT

For others to install the plugin with [BRAT](https://github.com/TfTHacker/obsidian42-brat)
the repository must be reachable by them:

- **Public repo** (this one): add `iluha067/Unison` in BRAT. No token needed.
- **Private repo**: each person needs collaborator access plus a read-only
  token in BRAT's settings. Only practical for small private beta groups.

BRAT and Obsidian read `manifest.json` from the repository root and download the
matching GitHub **release assets** (`manifest.json`, `main.js`, `styles.css`).

## Releasing a new version

1. Bump `version` in `manifest.json` and `package.json`.
2. Add the new entry to `versions.json` (plugin version -> minimum app version).
3. Add a note to `CHANGELOG.md`.
4. Commit, push to `main`, then push a tag equal to the new version, for example:

   ```bash
   git tag 3.0.1
   git push origin 3.0.1
   ```

The `Release` workflow builds a GitHub release with the three plugin files, and
the next check on any client offers the update.
