[CmdletBinding()]
param([switch]$RunTests)

$ErrorActionPreference = 'Stop'
$testRepoRoot = Split-Path -Parent $PSScriptRoot
$testPreviousUri = $env:NAIJAGO_TEST_MONGO_URI
$testPreviousAllow = $env:NAIJAGO_ALLOW_ATLAS_TESTS
$testPasswordPointer = [IntPtr]::Zero
$testSecurePassword = $null
$testPlainPassword = $null
$testUri = $null
$testExitCode = 1
Push-Location -LiteralPath $testRepoRoot
try {
    Write-Host 'Dedicated test cluster: naijago-testing.kwcvhix.mongodb.net'
    if ($RunTests) {
        Write-Host 'This runs isolated tests and removes only collections created by this test run.'
    } else {
        Write-Host 'Connection check only. No test data will be written.'
    }
    $testUsername = Read-Host 'Test database username'
    if ([string]::IsNullOrWhiteSpace($testUsername)) { throw 'A test database username is required.' }
    $testSecurePassword = Read-Host 'Test database password (hidden; do not paste it into chat)' -AsSecureString
    $testPasswordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($testSecurePassword)
    $testPlainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($testPasswordPointer)
    if ([string]::IsNullOrEmpty($testPlainPassword)) { throw 'A test database password is required.' }
    $testUri = 'mongodb+srv://{0}:{1}@naijago-testing.kwcvhix.mongodb.net/naijago_integration_tests?retryWrites=true&w=majority&authSource=admin&appName=NaijaGoIntegrationTests' -f [Uri]::EscapeDataString($testUsername.Trim()), [Uri]::EscapeDataString($testPlainPassword)
    $env:NAIJAGO_TEST_MONGO_URI = $testUri
    $env:NAIJAGO_ALLOW_ATLAS_TESTS = 'true'
    if ($RunTests) {
        & node --test test/integration/exploreMongo.test.js
    } else {
        & node scripts/checkTestDatabase.js
    }
    $testExitCode = $LASTEXITCODE
} finally {
    $env:NAIJAGO_TEST_MONGO_URI = $testPreviousUri
    $env:NAIJAGO_ALLOW_ATLAS_TESTS = $testPreviousAllow
    if ($testPasswordPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($testPasswordPointer) }
    if ($null -ne $testSecurePassword) { $testSecurePassword.Dispose() }
    $testPlainPassword = $null
    $testUri = $null
    Pop-Location
}
if ($testExitCode -ne 0) { throw 'The test check did not pass. Share only the safe error message, never your password or connection string.' }
