param(
    [string]$action = "toggle",
    [double]$param = 0.0
)

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]

function Await($asyncOp, $type) {
    $asTask = $asTaskGeneric.MakeGenericMethod($type)
    $netTask = $asTask.Invoke($null, @($asyncOp))
    $netTask.Wait(-1) | Out-Null
    return $netTask.Result
}

try {
    # Windows Media Controls (SMTC) for playback
    [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime] | Out-Null
    $managerOp = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()
    $manager = Await $managerOp ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])

    $sessions = $manager.GetSessions()
    $target = $sessions | Where-Object { $_.SourceAppUserModelId -match "justanothermusicclient" } | Select-Object -First 1

    if (-not $target) {
        $target = $sessions | Where-Object { $_.SourceAppUserModelId -match "msedgewebview2" } | Select-Object -First 1
    }

    if (-not $target) {
        $target = $manager.GetCurrentSession()
    }

    if ($target) {
        switch ($action) {
            "play" {
                $res = Await ($target.TryPlayAsync()) ([bool])
                Write-Host "PLAY: $res"
            }
            "pause" {
                $res = Await ($target.TryPauseAsync()) ([bool])
                Write-Host "PAUSE: $res"
            }
            "toggle" {
                $res = Await ($target.TryTogglePlayPauseAsync()) ([bool])
                Write-Host "TOGGLE: $res"
            }
            "next" {
                $res = Await ($target.TrySkipNextAsync()) ([bool])
                Write-Host "NEXT: $res"
            }
            "prev" {
                $res = Await ($target.TrySkipPreviousAsync()) ([bool])
                Write-Host "PREV: $res"
            }
            "seek" {
                $ticks = [long]($param * 10000000)
                $res = Await ($target.TryChangePlaybackPositionAsync($ticks)) ([bool])
                Write-Host "SEEK: $res"
            }
        }
    } else {
        Write-Host "No media session found"
    }
} catch {
    Write-Host "Error: $($_.Exception.Message)"
}
