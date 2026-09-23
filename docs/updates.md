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

The repository is public, so updates need no configuration: files are fetched
from the raw CDN with a cache-buster (`?t=<timestamp>`).

## Installing via BRAT

[BRAT](https://github.com/TfTHacker/obsidian42-brat) installs plugins from
GitHub releases. Add `iluha067/Unison` in **BRAT -> Add beta plugin**, then
enable **Unison**. Obsidian and BRAT read `manifest.json` from the repository
root and download the matching release assets (`manifest.json`, `main.js`,
`styles.css`).

## Releasing a new version

1. Bump `version` in `manifest.json` and `package.json`.
2. Add the new entry to `versions.json` (plugin version -> minimum app version).
3. Add a note to `CHANGELOG.md`.
4. Commit, push to `main`, then push a tag equal to the new version:

   ```bash
   git tag 3.0.1
   git push origin 3.0.1
   ```

The `Release` workflow builds a GitHub release with the three plugin files, and
the next check on any client offers the update.
