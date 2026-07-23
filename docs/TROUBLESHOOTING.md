# Troubleshooting Aux Proton Bridge

## `proton-drive: command not found`

Aux Proton Bridge requires Proton's official CLI to be installed as `proton-drive`.

Check:

```bash
proton-drive version
```

If that fails, install Proton Drive CLI and make sure it is on your `PATH`.

## Login browser does not open

Try logging in manually from a terminal:

```bash
proton-drive auth login
```

Complete the browser login, then restart Aux Proton Bridge and click **Refresh status**.

## Login succeeds but app still says not authenticated

Try:

1. Close Aux Proton Bridge.
2. Run:

```bash
proton-drive filesystem list /my-files
```

3. If the CLI lists files, reopen Aux Proton Bridge.
4. If the CLI fails, fix CLI auth/keyring first.

## Keyring / secret storage errors

Proton CLI stores sessions in the OS secret store.

Common providers:

- KDE Plasma: KWallet
- GNOME/Cinnamon/etc.: GNOME Keyring/libsecret
- Other/headless setups: `pass`, if supported by Proton CLI

If auth fails after browser login, check that your desktop keyring is installed, unlocked, and running.

## SQLite/cache lock or CLI busy

Cause: another `proton-drive` process is using the local CLI cache.

Fix:

1. Let the running Proton CLI operation finish.
2. Do not start multiple large downloads at once.
3. Restart Aux Proton Bridge if needed.
4. Click **Refresh status**.

The app serializes operations it starts, but cannot prevent separate terminal operations from locking the CLI cache.

## Download is slow or appears stuck

Large Proton Drive folders can take a long time.

Check:

- network connection
- available disk space
- whether a large file is currently downloading
- whether another Proton CLI process is running

## Existing files are not overwritten

This is expected in v0.1.0.

Downloads use:

```text
file conflicts: skip
folder conflicts: merge
```

This is intentionally conservative.

## AppImage does not launch

Some Linux systems need FUSE support for AppImage.

Options:

1. Install your distro's AppImage/FUSE support package.
2. Use the `.deb` or `.rpm` package if your distro supports it.
3. Extract and run the AppImage manually if needed.

## `.deb` install fails

Try installing with dependency resolution:

```bash
sudo apt install ./Aux.Proton.Bridge-0.1.0-amd64.deb
```

If you used `dpkg` and dependencies failed:

```bash
sudo apt -f install
```

## `.rpm` install fails

Fedora/RHEL-family:

```bash
sudo dnf install ./Aux.Proton.Bridge-0.1.0-x86_64.rpm
```

openSUSE:

```bash
sudo zypper install ./Aux.Proton.Bridge-0.1.0-x86_64.rpm
```

## White screen or app window opens blank

Try launching from a terminal to capture logs.

If running from source:

```bash
npm start
```

If using AppImage:

```bash
./Aux.Proton.Bridge-0.1.0-x86_64.AppImage
```

## Files downloaded to the wrong folder

Check the local folder field before starting a download.

Recommended default style:

```text
/home/you/ProtonDrive
```

## Upload went to the wrong remote location

v0.1.0 uploads to `/my-files` through the CLI wrapper. More advanced remote destination selection is future work.

## How to report a bug

Include:

- Linux distribution/version
- install method: AppImage, `.deb`, `.rpm`, or source
- Aux Proton Bridge version
- Proton Drive CLI version
- what you clicked
- what you expected
- what happened
- sanitized logs

Do **not** include:

- Proton passwords
- 2FA codes
- recovery phrases
- auth URLs with payloads
- session JSON/tokens
