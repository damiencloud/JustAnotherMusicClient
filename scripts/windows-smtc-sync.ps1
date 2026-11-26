Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]

function Await($asyncOp, $type) {
    $asTask = $asTaskGeneric.MakeGenericMethod($type)
    $netTask = $asTask.Invoke($null, @($asyncOp))
    $netTask.Wait(-1) | Out-Null
    return $netTask.Result
}

try {
    [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime] | Out-Null
    $manager = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])

    while ($true) {
        try {
            $sessions = $manager.GetSessions()
            $target = $sessions | Where-Object { $_.SourceAppUserModelId -match "justanothermusicclient" } | Select-Object -First 1
            if (-not $target) {
                $target = $sessions | Where-Object { $_.SourceAppUserModelId -match "msedgewebview2" } | Select-Object -First 1
            }
            if (-not $target) {
                $target = $manager.GetCurrentSession()
            }

            if ($target) {
                $info = Await ($target.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
                $pb = $target.GetPlaybackInfo()
                $tl = $target.GetTimelineProperties()

                if ($info -and $info.Title) {
                    $status = $pb.PlaybackStatus.ToString().ToLower()
                    $title = $info.Title
                    $artist = $info.Artist
                    $pos = [math]::Round($tl.Position.TotalSeconds, 1)
                    $dur = [math]::Round($tl.EndTime.TotalSeconds, 1)

                    $state = [PSCustomObject]@{
                        app = $target.SourceAppUserModelId
                        status = $status
                        currentTime = $pos
                        duration = $dur
                        title = $title
                        artist = $artist
                    }

                    $json = ConvertTo-Json -Compress $state
                    [Console]::Out.WriteLine("SMTC:" + $json)
                    [Console]::Out.Flush()
                }
            }
        } catch {
            # continue loop
        }
        Start-Sleep -Milliseconds 750
    }
} catch {
    [Console]::Error.WriteLine("Error in SMTC sync: $($_.Exception.Message)")
}
