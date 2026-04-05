[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null

$bridgeFile = Join-Path $env:USERPROFILE ".claude\notify-path"
$projectPath = if (Test-Path $bridgeFile) {
    (Get-Content $bridgeFile -Raw).Trim()
} else {
    (Get-Location).Path
}
$projectName = Split-Path -Leaf $projectPath
$vscodePath = $projectPath -replace '\\', '/'
$vscodeUri = "vscode://file/$vscodePath"

$template = @"
<toast activationType="protocol" launch="$vscodeUri">
    <visual>
        <binding template="ToastGeneric">
            <text>Claude Code - Done</text>
            <text>Task completed in: $projectName</text>
        </binding>
    </visual>
    <audio src="ms-winsoundevent:Notification.Default" />
</toast>
"@

$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml($template)
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("Microsoft.Windows.Shell.RunDialog").Show($toast)

[System.Media.SystemSounds]::Asterisk.Play()
