# Use Aux Proton Drive Bridge

Aux Proton Drive Bridge is a desktop GUI for Proton Drive operations through Proton's official `proton-drive` CLI.

## What it is

A Linux desktop bridge for Proton Drive operations:

- sign in/out
- check CLI/auth status
- list `/my-files`
- download selected files/folders
- download everything visible from `/my-files`
- upload local files/folders
- choose and open a local destination folder
- view activity logs and operation history
- one-way backup profile with scheduler (30 min)
- background sync engine with local file watching and remote polling
- conflict detection and resolution
- live transfer queue with pause/resume/cancel
- software update checking via GitHub Releases
- capability-gated FUSE adapter; unavailable with Proton Drive CLI 0.6.0

## Tab overview

The app is organized into tabs:

| Tab | Purpose |
|---|---|
| **Files** | Manual file listing, download, upload, backup profile |
| **Sync** | Sync engine - start/stop, mode selection, pending items |
| **Conflicts** | Conflict detection and resolution |
| **Queue** | Live transfer queue - active, pending, completed transfers |
| **FUSE Mount** | Mount Proton Drive as a filesystem directory |
| **Updates** | Check for and download software updates |

## Sign in

1. Open Aux Proton Drive Bridge.
2. Click **Sign in**.
3. Proton's CLI opens the Proton browser login flow.
4. Complete login in the browser.
5. Return to the app.
6. Click **Refresh status** or **Refresh files**.

The app does not see your Proton password. Auth is handled by:

```bash
proton-drive auth login
```

## Sign out

Click **Sign out**.

This delegates logout to the Proton CLI.

## Refresh files

Click **Refresh files** to list Proton Drive `/my-files`.

The app reads the top-level Proton Drive files/folders exposed by the CLI.

## Choose local folder

Use the local folder field or folder picker to choose where downloads should go.

Example:

```text
/home/you/ProtonDrive
```

## Download selected

1. Click **Refresh files**.
2. Select one or more files/folders.
3. Choose the local destination folder.
4. Click **Download selected**.

Transfer defaults:

```text
folder conflicts: merge
file conflicts: skip
```

This means existing folders are merged and existing files are not overwritten.

## Download everything

Click **Download everything** to download all visible `/my-files` entries into the chosen local folder.

Use this carefully for large Proton Drive accounts. The Proton CLI can take a long time on large drives.

## Upload files/folders

1. Click **Upload files/folders**.
2. Choose local files or folders.
3. The app sends them to Proton Drive through the CLI.

Current default remote destination is `/my-files`.

## Background sync

The **Sync** tab lets you start the background sync engine.

### Sync modes

| Mode | Behavior |
|---|---|
| **Conservative** (default) | Upload only, skip existing files, merge folders. Safest for first use. |
| **One-way upload** | Local changes → Remote. Does not download. |
| **One-way download** | Remote changes → Local. Does not upload. |
| **Bidirectional** | Full two-way sync. Experimental - start with Conservative mode first. |

### How to use

1. Switch to the **Sync** tab.
2. Select a sync mode (start with Conservative).
3. Click **Start sync**.
4. The sync engine watches for local file changes and polls the remote state.
5. Pending sync items appear in the pending list.
6. Individual transfers go through the transfer queue.
7. Click **Scan now** to trigger an immediate sync cycle.

> ⚠ Bidirectional sync is experimental. Start with **Conservative** mode and verify behavior before switching.

The bridge uses a no-delete policy. When one side disappears, it preserves or restores the surviving copy instead of deleting cloud or local data. A transfer reported as skipped by the CLI remains unresolved and is shown as a conflict.

## Transfer queue

The **Queue** tab shows the current state of all transfers:

- **Active** - Currently running transfers
- **Pending** - Queued transfers waiting to start
- **Recent completed** - Recently finished or failed transfers

You can **pause**, **resume**, or **cancel** transfers from this tab.

## Conflicts

When the sync engine detects that a file changed both locally and remotely, it records a **conflict**. The **Conflicts** tab shows all active conflicts with resolution options:

| Strategy | Effect |
|---|---|
| **keep_local** | Upload local version, overwriting remote |
| **keep_remote** | Download remote version, overwriting local |
| **keep_both** | Rename the local copy with a conflict suffix, then download the remote copy to the original path |
| **skip** | Leave both sides as-is |

## FUSE mount

The **FUSE Mount** tab reports mounting as unavailable in v0.3.3. Proton Drive CLI 0.6.0 has no mount command, and this release does not bundle a safely owned mount helper. The bridge does not start a guessed or orphanable mount process.

## Activity log

The activity log shows app/CLI progress and errors.

Do not paste logs publicly without checking them. The app is designed not to expose auth payloads, but paths and filenames may still reveal private information.

## Busy / locked CLI state

The Proton CLI uses local state/cache files. If another Proton CLI operation is already running, the app may show the CLI as busy or fail with a SQLite/cache lock message.

Fix:

1. Wait for the existing Proton CLI operation to finish.
2. Click **Refresh status**.
3. Retry the action.

The app serializes operations it starts, but it cannot control separate terminal processes already running outside the app.

## Safe workflow for first use

1. Install Proton CLI.
2. Sign in through Aux Proton Drive Bridge.
3. Download one small folder first.
4. Confirm local files look right.
5. Then download larger folders.
6. Keep `file conflicts: skip` behavior until you trust the workflow.
7. When ready, start the sync engine in **Conservative** mode.

## Recommended local folder

A normal local folder under your home directory is safest:

```text
/home/you/ProtonDrive
```

Avoid system folders and removable drives until the workflow has been tested.

## Software updates

Open the **Updates** tab and click **Check for updates**. If a new version is available:

1. Click **Download update**.
2. When the download completes, the app shows install instructions.
3. Follow the instructions (e.g., `sudo rpm -Uvh <file>` for RPM-based systems).

The app also checks for updates automatically every 6 hours when running.

## Uninstalling

Uninstalling Aux Proton Drive Bridge does not delete your Proton account or Proton Drive data.

It also should not delete files you downloaded locally unless you manually remove them.

Use your distro package manager for `.deb`/`.rpm`, or delete the AppImage file for AppImage installs.
