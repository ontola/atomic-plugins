# File inventories in SyncD

SyncD can index Dropbox, Google Drive and a Mac's iCloud Drive. It stores
file metadata in the existing local PostgreSQL snapshots. Provider
requests are limited to account identification and metadata listings.
The iCloud scan enumerates folders and reads filesystem attributes.
Browse, history and duplicate reports use the stored inventory offline.

## Configure the sources

Add entries like these to the `collections` array in your private SyncD
config. Paths resolve relative to the config file. Replace the iCloud path
with the directory on your Mac. You can configure any subset or use
different `account` labels for multiple accounts.

```json
[
  {
    "account": "personal",
    "name": "files",
    "fileInventory": { "provider": "dropbox", "tokenFile": "./dropbox.token" }
  },
  {
    "account": "personal",
    "name": "files",
    "fileInventory": { "provider": "google-drive", "tokenFile": "./drive.token" }
  },
  {
    "account": "personal",
    "name": "files",
    "fileInventory": {
      "provider": "icloud-drive",
      "directory": "/Users/yourname/Library/Mobile Documents/com~apple~CloudDocs"
    },
    "readLimits": { "timeoutMs": 300000 }
  }
]
```

- **Dropbox** uses an OAuth user access token with `files.metadata.read`
  and `account_info.read`. Choose **Full Dropbox** access when you create
  the app to inventory the files in the account's default namespace.
  Each record has a Dropbox ID and a path. The inventory tracks changes
  by Dropbox's case-insensitive path because deletion entries carry that
  path. A rename updates the location in the next snapshot.
  [Dropbox app and OAuth guide](https://docs.dropboxapi.com/dropbox-api/docs/oauth)
- **Google Drive** uses an OAuth user access token with
  `https://www.googleapis.com/auth/drive.metadata.readonly`. Enable the
  Drive API for the OAuth client. SyncD lists files in the account's user
  corpus and follows its change feed. Records use Drive IDs and include
  parent IDs when available. Google Docs and shortcuts appear even when
  Drive has no content checksum for them. A complete scan of every shared
  drive requires separate per-drive feeds.
  [Google Drive OAuth scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)
- **iCloud Drive** runs under a macOS user that can browse the configured
  directory. It lists regular files exposed by Finder, including
  cloud-only placeholders, and skips symlinks. macOS may fetch directory
  entries while enumerating cloud-only folders. SyncD never opens the file
  data. The inventory covers iCloud Drive files exposed to that Mac.
  [Apple's guidance on dataless files](https://developer.apple.com/documentation/technotes/tn3150-getting-ready-for-data-less-files)

Each cloud token file contains only the current access token, with an
optional final newline. Create it with owner-only permissions (`chmod 600`).
Use your OAuth client to refresh the token and atomically replace the
file. SyncD reloads it when starting a sync and checks that it belongs to
the same provider account as the saved inventory. Keep using the same
OAuth app and access level for each collection. SyncD's Local Thought
device login is used by other collection types. It is unnecessary for
these sources.

## Sync and browse

With the usual local `SYNCABLES_DATABASE_URL` configured, run:

```sh
syncables sync --config config.json
syncables browse dropbox/personal/files --config config.json
syncables browse google-drive/personal/files --config config.json
syncables browse icloud-drive/personal/files --config config.json
syncables file-duplicates --config config.json
```

The browser started by `syncables ui --config config.json` also shows
completed inventories up to its 50,000-resource and 32 MiB limits. Use
the CLI for larger inventories. Browse returns file names, provider IDs or paths,
available size and modification time, revisions and reported hashes.
Sizes are decimal strings so large values stay exact. Use `history` and
`browse --at` to inspect prior observations. File inventories remain
in PostgreSQL by default. Use `checkout` if you want JSON records on disk.

The first Dropbox and Google Drive sync lists files. Later syncs use a
provider cursor to pick up additions, changes and deletions. When a
cursor expires, SyncD builds a fresh inventory and keeps the previous
one browsable until the replacement completes. A manual sync returning
`"pending": true` saved progress. Run `sync` again to resume, or use
`syncables daemon --config config.json` to continue automatically. The
daemon uses `pollSeconds` between completed scans. iCloud Drive rescans
the directory each time.

Set `readLimits.maxRecords`, `readLimits.maxRequests` and
`readLimits.timeoutMs` per collection. The cloud defaults are 5,000
entries, 1,000 listing requests and 120 seconds per attempt. A cloud
checkpoint advances at page boundaries, so a final page can take the
attempt past its record budget. iCloud Drive defaults to 250,000 files
and a 120-second deadline for the full scan. If it reaches a limit,
the previous inventory remains available and the next scan starts
from the root. PostgreSQL accepts up to 250,000 files and 192 MiB of
expanded snapshot JSON per inventory.

`file-duplicates` shows the revision it used for each inventory.
Confirmed groups link files through matching checksums of the same algorithm.
Candidate groups contain same-name, same-size files across providers
whose shared content is still unverified. Dropbox's block-based content
hash is a separate algorithm from plain SHA-256. iCloud Drive has no
checksums in this scan because computing them would read the files.
[Dropbox content hash](https://www.dropbox.com/developers/reference/content-hash)
