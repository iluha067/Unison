# Plugin updates (public and private repositories)

The plugin updates itself from the branch configured at the top of
`plugin/main.js`:

```js
const UPDATE_REPO = 'https://raw.githubusercontent.com/iluha067/Unison/main';
```

- **Background check** (every 6 h and shortly after startup) only *notifies*
  about a newer version. It never installs anything on its own.
- **Manual check** (**Settings → Unison → Check for update** or the command
  palette) downloads `manifest.json`, `main.js` and `styles.css`, writes them
  into the plugin folder and reloads Obsidian.

## Public repository

Nothing to configure — files are fetched over the raw CDN with a cache-buster
(`?t=<timestamp>`).

## Private repository

The raw CDN does **not** serve private files, so Unison switches to the GitHub
Contents API whenever a token is present:

1. Open **Settings → Unison**.
2. Paste a GitHub token into **"Update token (private repo)"**.
3. Press **Check for update**.

Requirements for the token:

- A **fine-grained** token with **Contents: Read** access to this repository, or
  a classic token with the `repo` scope.
- The token has read access to `iluha067/Unison`.

Downloads then go to
`https://api.github.com/repos/iluha067/Unison/contents/<file>?ref=main` with the
header `Authorization: Bearer <token>` and `Accept: application/vnd.github.raw`.

### Security note

The token is stored in the plugin's `data.json` in plain text (Obsidian offers
no secret store). Use a **read-only, repository-scoped** token and revoke it if
the vault is shared. If you do not need self-updates, leave the field empty and
update manually.

## Releasing a new version

1. Bump `version` in `plugin/manifest.json` and `plugin/package.json`.
2. Add the new entry to `plugin/versions.json` (plugin version → minimum app
   version).
3. Add a note to `CHANGELOG.md`.
4. Commit and push to the branch named in `UPDATE_REPO` (`main`).

The next manual check on any client installs the new build.
