# Use Aux Proton Drive Bridge

Aux Proton Drive Bridge is a GUI for Proton Drive operations through Proton's official `proton-drive` CLI.

## What it is

A Linux desktop bridge for manual Proton Drive operations:

- sign in/out
- check CLI/auth status
- list `/my-files`
- download selected files/folders
- download everything visible from `/my-files`
- upload local files/folders
- choose and open a local destination folder
- view activity logs

## What it is not yet

v0.2.1 is **not yet** a full bidirectional sync daemon.

It does not yet provide:

- automatic background two-way sync
- remote delete propagation
- local delete propagation
- conflict database/review UI
- tray daemon
- selective sync profiles

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

## Activity log

The activity log shows app/CLI progress and errors.

Do not paste logs publicly without checking them. The app is designed not to expose auth payloads, but paths and filenames may still reveal private information.

## Busy / locked CLI state

The Proton CLI uses local state/cache files. If another Proton CLI operation is already running, the app may show the CLI as busy or fail with a SQLite/cache lock message.

Fix:

1. Wait for the existing Proton CLI operation to finish.
2. Click **Refresh status**.
3. Retry the action.

The app serializes operations it starts itself, but it cannot control separate terminal processes already running outside the app.

## Safe workflow for first use

1. Install Proton CLI.
2. Sign in through Aux Proton Drive Bridge.
3. Download one small folder first.
4. Confirm local files look right.
5. Then download larger folders.
6. Keep `file conflicts: skip` behavior until you trust the workflow.

## Recommended local folder

A normal local folder under your home directory is safest:

```text
/home/you/ProtonDrive
```

Avoid system folders and removable drives until the workflow has been tested.

## Updating the app

Download the newer release artifact from GitHub Releases and install it over the old version.

For AppImage users, replace the old AppImage file with the new one.

## Uninstalling

Uninstalling Aux Proton Drive Bridge does not delete your Proton account or Proton Drive data.

It also should not delete files you downloaded locally unless you manually remove them.

Use your distro package manager for `.deb`/`.rpm`, or delete the AppImage file for AppImage installs.
