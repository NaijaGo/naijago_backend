# Requires Windows PowerShell 5.1+ and MongoDB Database Tools.
# Reads one database only. It never restores, drops, or updates a collection.
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$backupBase = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../backups/local'))
$runDirectory = $null
$configPath = $null
$plainUri = $null
$secureUri = $null
$nativeExitCode = $null

function Get-MongoBackupUriInfo([string] $Value) {
    # Return only safe guidance and the database name, never credentials/hosts.
    if ([string]::IsNullOrWhiteSpace($Value)) {
        return @{ Valid = $false; Message = 'The connection string was empty. Paste it at this prompt, not at the PS command prompt.' }
    }
    if ($Value -match '<[^>]+>') {
        return @{ Valid = $false; Message = 'Replace placeholders such as <db_password> with the actual database-user password privately. Alternatively, copy the complete existing MONGO_URI privately from Render.' }
    }
    if ($Value -match '\s|%(?![a-fA-F0-9]{2})') {
        return @{ Valid = $false; Message = 'The URI contains whitespace or an invalid percent escape. Use the complete existing connection string, with password special characters URL-encoded.' }
    }
    # System.Uri does not understand MongoDB's comma-separated host lists.
    # Parse MongoDB's structure here and let mongodump validate server options.
    $parsed = [regex]::Match($Value, '^(?<scheme>mongodb(?:\+srv)?)://(?<authority>[^/?#]+)(?:/(?<database>[^/?#]*))?(?:\?(?<options>[^#]*))?$')
    if (-not $parsed.Success) {
        return @{ Valid = $false; Message = 'Use a complete mongodb+srv:// or mongodb:// connection string without surrounding quotation marks.' }
    }
    $authority = $parsed.Groups['authority'].Value
    $at = $authority.LastIndexOf('@')
    if ($at -ge 0 -and $authority.IndexOf('@') -ne $at) {
        return @{ Valid = $false; Message = 'Special characters in the username/password must be URL-encoded. Prefer copying the existing working MONGO_URI privately.' }
    }
    $hosts = $authority.Substring($at + 1)
    $validHosts = $true
    if ($parsed.Groups['scheme'].Value -eq 'mongodb+srv') {
        $validHosts = $hosts -match '^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$'
    } else {
        foreach ($hostEntry in $hosts.Split(',')) {
            if ($hostEntry -notmatch '^(?:[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?|\[[a-fA-F0-9:]+\])(?::\d{1,5})?$') { $validHosts = $false }
        }
    }
    if (-not $validHosts) {
        return @{ Valid = $false; Message = 'The database host format is invalid. SRV uses one hostname; standard MongoDB URIs may use a comma-separated host list.' }
    }
    try { $uriDatabase = [Uri]::UnescapeDataString($parsed.Groups['database'].Value) }
    catch { return @{ Valid = $false; Message = 'The database name in the connection string has invalid URL encoding.' } }
    return @{ Valid = $true; Database = $uriDatabase; Message = '' }
}

function Protect-BackupDirectory([string] $Path) {
    $item = Get-Item -LiteralPath $Path
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw 'Backup directories must not be links or junctions.'
    }
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $system = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
    foreach ($sid in @($identity, $system)) {
        $rule = New-Object Security.AccessControl.FileSystemAccessRule(
            $sid, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')
        $acl.AddAccessRule($rule)
    }
    $acl.SetOwner($identity)
    Set-Acl -LiteralPath $Path -AclObject $acl
}

try {
    $dump = (Get-Command mongodump.exe -CommandType Application -ErrorAction Stop).Source
    Write-Host 'NaijaGo local MongoDB backup' -ForegroundColor Cyan
    Write-Host 'This exports one database. No data will be restored or changed.'
    Write-Host 'Paste your MongoDB URI only into the private prompt below, not into chat.'
    Write-Host 'A connection string is data for this script; it is not a PowerShell command.'
    do {
        if ($secureUri) { $secureUri.Dispose(); $secureUri = $null }
        $plainUri = $null
        $secureUri = Read-Host 'MongoDB connection string (input hidden)' -AsSecureString
        $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureUri)
        try { $plainUri = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr).Trim() }
        finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
        $uriInfo = Get-MongoBackupUriInfo $plainUri
        if (-not $uriInfo.Valid) { Write-Host $uriInfo.Message -ForegroundColor Yellow }
    } until ($uriInfo.Valid)
    $uriDatabase = $uriInfo.Database
    do {
        $database = (Read-Host 'Exact database name to back up (from Atlas Browse Collections)').Trim()
        $validDatabase = $database -match '^[A-Za-z0-9_-]{1,63}$' -and $database -notin @('admin', 'local', 'config')
        if (-not $validDatabase) {
            Write-Host 'Use the exact application database name, not the project or cluster name.' -ForegroundColor Yellow
        } elseif ($uriDatabase -and $uriDatabase -ne $database) {
            $validDatabase = $false
            Write-Host 'The database name differs from the name already in the URI. Enter that database name, or press Ctrl+C to restart with another URI.' -ForegroundColor Yellow
        }
    } until ($validDatabase)
    # Refuse junction ancestors before creating or changing a directory ACL.
    $ancestor = $backupBase
    while ($ancestor) {
        if (Test-Path -LiteralPath $ancestor) {
            $entry = Get-Item -LiteralPath $ancestor
            if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw 'The backup path must not contain links or junctions.'
            }
        }
        $parent = [IO.Directory]::GetParent($ancestor)
        $ancestor = if ($parent) { $parent.FullName } else { $null }
    }
    New-Item -ItemType Directory -Path $backupBase -Force | Out-Null
    Protect-BackupDirectory $backupBase
    $stamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ')
    $runDirectory = Join-Path $backupBase ("{0}-{1}" -f $stamp, [Guid]::NewGuid().ToString('N').Substring(0, 8))
    New-Item -ItemType Directory -Path $runDirectory | Out-Null
    $configPath = Join-Path $runDirectory 'connection.private.yml'
    $partial = Join-Path $runDirectory 'database.archive.gz.partial'
    $archive = Join-Path $runDirectory 'database.archive.gz'
    $stdoutLog = Join-Path $runDirectory 'mongodump.stdout.log'
    $stderrLog = Join-Path $runDirectory 'mongodump.stderr.log'
    $utf8 = New-Object Text.UTF8Encoding($false)
    # Single-quoted YAML scalars escape a quote by doubling it.
    [IO.File]::WriteAllText($configPath, ("uri: '" + $plainUri.Replace("'", "''") + "'`n"), $utf8)
    $plainUri = $null
    $secureUri.Dispose()
    $secureUri = $null
    $started = [DateTime]::UtcNow
    Write-Host "Exporting database: $database"
    Write-Host 'Using one collection worker to reduce pressure on the source.'
    Write-Host "Private output folder: $runDirectory"
    $arguments = @("--config=$configPath", "--db=$database", "--archive=$partial", '--gzip', '--numParallelCollections=1')
    # Native stderr is captured privately. PowerShell 5.1 otherwise treats native
    # progress output as terminating errors when ErrorActionPreference is Stop.
    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        & $dump @arguments 1> $stdoutLog 2> $stderrLog
        $nativeExitCode = $LASTEXITCODE
    } finally { $ErrorActionPreference = $previousPreference }
    if ($nativeExitCode -ne 0) {
        throw "mongodump failed (exit $nativeExitCode). Private logs are in the output folder; do not share them without redacting credentials."
    }
    if (-not (Test-Path -LiteralPath $partial) -or (Get-Item -LiteralPath $partial).Length -eq 0) {
        throw 'mongodump did not produce a nonempty archive.'
    }
    Move-Item -LiteralPath $partial -Destination $archive
    $digest = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText((Join-Path $runDirectory 'SHA256SUMS.txt'), "$digest  database.archive.gz`n", $utf8)
    $manifest = [ordered]@{
        status = 'export_completed'
        database = $database
        startedUtc = $started.ToString('o')
        completedUtc = [DateTime]::UtcNow.ToString('o')
        archive = 'database.archive.gz'
        bytes = (Get-Item -LiteralPath $archive).Length
        sha256 = $digest
        toolVersion = ((& $dump --version | Select-Object -First 1) -join '')
        scope = 'Single-database logical export; not a full Atlas project backup.'
        consistency = 'Not a coordinated point-in-time snapshot. Concurrent writes can produce cross-collection inconsistencies.'
        restoreTest = 'NOT PERFORMED. Requires a separate isolated target.'
        encrypted = $false
    }
    [IO.File]::WriteAllText((Join-Path $runDirectory 'manifest.json'), ($manifest | ConvertTo-Json), $utf8)
    Write-Host 'BACKUP EXPORT COMPLETED' -ForegroundColor Green
    Write-Host "Archive: $archive"
    Write-Host "SHA256: $digest"
    Write-Host 'A checksum was recorded. Recoverability is not verified until an isolated restore succeeds.'
    Write-Host 'The archive is compressed, not encrypted. Keep it private and use encrypted storage for any additional copy.'
} catch {
    # Do not echo arbitrary tool/parser exceptions which may include a URI.
    Write-Host 'BACKUP NOT CONFIRMED. No restore operation was performed.' -ForegroundColor Red
    if ($runDirectory) { Write-Host "Check the private output folder: $runDirectory" }
    if ($null -ne $nativeExitCode) { Write-Host "mongodump exit code: $nativeExitCode" }
    Write-Host 'Check the tool installation, URI, database name, Atlas access rules and available disk space privately.'
    Write-Host 'Restart the backup script to retry. Do not enter a connection string as a PowerShell command.'
    exit 1
} finally {
    $plainUri = $null
    if ($secureUri) { $secureUri.Dispose() }
    if ($configPath -and (Test-Path -LiteralPath $configPath)) {
        Remove-Item -LiteralPath $configPath -Force
    }
}
