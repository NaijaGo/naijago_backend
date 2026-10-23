# Local MongoDB backup first

MongoDB Database Tools 100.14.0 (`mongodump` and `mongorestore`) were found on PATH.
There is no `.env` database URI configured in this checkout. No credentials or
database records were inspected and no dump has been run by preparing these files.

In your own PowerShell terminal, run:

```powershell
cd 'C:\vs code-codex\repositories\naijago_backend'
powershell.exe -NoProfile -ExecutionPolicy Bypass -File '.\scripts\backup\New-MongoLocalBackup.ps1'
```

The process-only execution policy does not change your saved system policy.
The script prompts for the MongoDB URI with hidden input and then the exact source
database name. Copy the URI privately from your existing configuration; use the
database name shown by Atlas Browse Collections. Do not assume a project or cluster
name is the database name. Never paste credentials into chat or a Git-tracked file.
Use an appropriately scoped export account rather than an unrestricted admin where
possible, and allow this PC's current public IP in Atlas network access if required.
If Atlas shows `<db_password>`, replace that placeholder privately with the database
user's actual password (with URI special characters URL-encoded). The existing
working Render `MONGO_URI` can instead be copied privately into the hidden prompt.
Do not execute the connection string at `PS ...>`: it is input to this script, not
a PowerShell command. Invalid inputs produce safe guidance and prompt again.
Both SRV and standard comma-separated MongoDB host-list URIs are supported.

The script passes credentials to mongodump using a temporary YAML config in a
directory restricted to your Windows account and SYSTEM. The config is removed in
`finally`; if the process is forcibly terminated or the PC loses power, inspect the
private backup folder and delete any remaining `connection.private.yml` locally.
Backup archives and logs remain private. They may include all customer, financial,
token and account data in that database. Do not commit or attach them to chat.

Only one explicitly named application database is exported, with gzip archive output
and one collection worker. A new uniquely named folder is created on every run:

```
backups/local/<UTC timestamp>-<random suffix>/
  database.archive.gz
  SHA256SUMS.txt
  manifest.json
  mongodump.stdout.log
  mongodump.stderr.log
```

This path is Git-ignored. A failed/incomplete dump keeps a `.partial` filename and
does not create the completed manifest. Existing backup archives are not overwritten.
If a run fails before output creation, the script reports that no backup is confirmed;
check the private URI, database name, installed tools and Atlas access configuration.

## What success means

`BACKUP EXPORT COMPLETED` means mongodump returned zero, produced a nonempty archive,
and a SHA-256 checksum/manifest were written. It **does not** mean a restore test passed.
You can check the archive against the recorded checksum later:

```powershell
Get-FileHash -Algorithm SHA256 -LiteralPath 'FULL_LOCAL_PATH_TO_DATABASE.archive.gz'
```

The gzip archive is not encrypted. Windows ACLs restrict ordinary access, but are
not encryption. Keep it on trusted storage and make an encrypted independent copy
as appropriate. A local-only backup does not protect against loss of the computer.

This is a single-database logical export, including collection metadata/index
definitions supported by mongodump. It is not an Atlas project export, user/role
backup, native snapshot, or cross-collection point-in-time backup. Source writes
continue; concurrent wallet/order writes may make the result transactionally
inconsistent. The script neither pauses production nor uses `--oplog` (not supported
on Atlas Free). For a financial recovery plan, evaluate coordinated backups/native
snapshot availability separately; do not treat this preliminary export as proven
disaster recovery.

## Restore test comes later

The user requested a local backup first and has not created the isolated cluster.
No restore command is included or run. Once a separate target is available, verify
the archive checksum, restore to an unused test namespace, compare collection/index
counts and representative invariants, and record the result. Never restore this
archive onto production to test it. Keep restored production data private and do
not use it as the public/synthetic load-test fixture.

Official references: [mongodump](https://www.mongodb.com/docs/database-tools/mongodump/),
[mongorestore](https://www.mongodb.com/docs/database-tools/mongorestore/),
[Atlas Free limits](https://www.mongodb.com/docs/atlas/reference/free-shared-limitations/).
