$ErrorActionPreference = 'Stop'
$binary = Join-Path $PSScriptRoot '../apps/admin-desktop/src-tauri/target/debug/udmc-control.exe'
$binary = (Resolve-Path -LiteralPath $binary).Path
$profile = 'instance-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
$oldProfile = $env:UDMC_TEST_PROFILE
$oldConnection = $env:UDMC_TEST_CONNECTION
$started = [System.Collections.Generic.List[System.Diagnostics.Process]]::new()

function Start-TestInstance {
    $process = Start-Process -FilePath $binary -WindowStyle Hidden -PassThru
    $started.Add($process)
    return $process
}

function Get-LiveInstances {
    return @($started | Where-Object { $_.Refresh(); -not $_.HasExited })
}

function Wait-TestWindow($process) {
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    do {
        $process.Refresh()
        if ($process.HasExited) { throw 'The primary instance exited before creating its window.' }
        if ($process.MainWindowTitle -eq "UDMC UI Test - $profile") { return }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'Timed out waiting for the isolated test window.'
}

try {
    $env:UDMC_TEST_PROFILE = $profile
    $env:UDMC_TEST_CONNECTION = $null
    $first = Start-TestInstance
    Wait-TestWindow $first
    $second = Start-TestInstance
    if (-not $second.WaitForExit(15000) -or $second.ExitCode -ne 0) { throw 'Second launch did not exit successfully.' }
    if ((Get-LiveInstances).Count -ne 1) { throw 'Second launch changed the primary instance.' }
    Write-Output 'PASS: second launch exits and the first process remains.'

    # Only processes started by this script are ever terminated.
    $first.Kill()
    $first.WaitForExit()
    for ($round = 0; $round -lt 3; $round++) {
        for ($launch = 0; $launch -lt 8; $launch++) { $null = Start-TestInstance }
        Start-Sleep -Seconds 5
        $live = @(Get-LiveInstances)
        if ($live.Count -ne 1) { throw "Burst launch left $($live.Count) instances running in round $round." }
        Wait-TestWindow $live[0]
        $live[0].Kill()
        $live[0].WaitForExit()
    }
    Write-Output 'PASS: three bursts of eight launches leave exactly one process; termination releases the lock.'
} finally {
    foreach ($process in $started) {
        $process.Refresh()
        if (-not $process.HasExited) { $process.Kill(); $process.WaitForExit() }
        $process.Dispose()
    }
    $env:UDMC_TEST_PROFILE = $oldProfile
    $env:UDMC_TEST_CONNECTION = $oldConnection
}
