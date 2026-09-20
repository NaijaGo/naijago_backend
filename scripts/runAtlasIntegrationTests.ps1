[CmdletBinding()]
param([switch]$RunTests, [ValidateSet('Explore', 'Search', 'Workers', 'Requests', 'Refinement', 'Planning', 'Checkout', 'All')][string]$Suite = 'Explore')

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
        Write-Host ('Suite: ' + $Suite + '. External providers are simulated; no paid provider calls.')
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
        $testFiles = @(switch ($Suite) {
            'Explore' { 'test/integration/exploreMongo.test.js' }
            'Search' { 'test/integration/searchMongo.test.js' }
            'Workers' { 'test/integration/workerMongo.test.js' }
            'Requests' { 'test/integration/requestMongo.test.js' }
            'Refinement' { 'test/integration/refinementMongo.test.js' }
            'Planning' { 'test/integration/planningMongo.test.js' }
            'Checkout' { 'test/integration/checkoutMongo.test.js' }
            'All' { 'test/integration/exploreMongo.test.js'; 'test/integration/searchMongo.test.js'; 'test/integration/workerMongo.test.js'; 'test/integration/requestMongo.test.js'; 'test/integration/refinementMongo.test.js'; 'test/integration/planningMongo.test.js'; 'test/integration/checkoutMongo.test.js' }
        })
        & node --test --test-concurrency=1 @testFiles
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
if ($testExitCode -ne 0) {
    Write-Host 'The check did not pass. Share only the diagnostic code, stage and guidance above; never your password or connection string.'
    exit $testExitCode
}
