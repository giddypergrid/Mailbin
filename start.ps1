# Find LAN IPv4 (Wi-Fi or Ethernet, skip loopback/virtual)
$lanIp = Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object {
    $_.IPAddress -notmatch '^127\.' -and
    $_.IPAddress -notmatch '^169\.254\.' -and
    $_.PrefixOrigin -ne 'WellKnown'
  } |
  Sort-Object InterfaceMetric |
  Select-Object -First 1 -ExpandProperty IPAddress

if (-not $lanIp) {
  Write-Host "Could not detect LAN IP — falling back to 127.0.0.1" -ForegroundColor Yellow
  $lanIp = '127.0.0.1'
}

Write-Host "Detected LAN IP: $lanIp" -ForegroundColor Cyan

# Inject IP into capacitor.config.ts for live reload on emulator/device.
# Save original content first so we can restore it on exit — keeps the
# checked-in file clean (no leftover LAN-IP diffs after every dev session).
$configPath = "$PSScriptRoot/frontend/capacitor.config.ts"
$originalConfig = Get-Content $configPath -Raw
$updated = $originalConfig -replace "server:\s*\{[^}]*\}", "server: { androidScheme: 'https', url: 'http://$lanIp`:5174', cleartext: true }"
Set-Content $configPath $updated -Encoding utf8

Write-Host "Injected server.url http://$lanIp`:5174 into capacitor.config.ts (will revert on exit)" -ForegroundColor Cyan

Push-Location -LiteralPath "$PSScriptRoot/frontend"
try {
  # Generate app icons from resources/ into Android mipmap folders
  Write-Host "Generating app icons from resources/..." -ForegroundColor Cyan
  npx @capacitor/assets generate --android --assetPath ./resources

  # Inject beige splash for Android 12+ — transparent icon makes it plain beige with nothing visible
  $resDir = "$PSScriptRoot/frontend/android/app/src/main/res"
  New-Item -ItemType Directory -Force "$resDir/values-v31" | Out-Null
  New-Item -ItemType Directory -Force "$resDir/drawable" | Out-Null

  # Transparent 1x1 vector — hides the system splash icon entirely
  Set-Content "$resDir/drawable/splash_icon_hidden.xml" -Encoding utf8 @'
<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="1dp"
    android:height="1dp"
    android:viewportWidth="1"
    android:viewportHeight="1">
</vector>
'@

  Set-Content "$resDir/values-v31/styles.xml" -Encoding utf8 @'
<?xml version="1.0" encoding="utf-8"?>
<resources>
    <style name="AppTheme.NoActionBarLaunch" parent="Theme.SplashScreen">
        <item name="android:windowSplashScreenBackground">#f5f0e8</item>
        <item name="android:windowSplashScreenAnimatedIcon">@drawable/splash_icon_hidden</item>
        <item name="postSplashScreenTheme">@style/AppTheme.NoActionBar</item>
    </style>
</resources>
'@
  Write-Host "Injected beige splash screen with hidden icon (values-v31)" -ForegroundColor Cyan

  # Sync web assets + updated config into the Android project
  Write-Host "Syncing Capacitor Android..." -ForegroundColor Cyan
  npx cap sync android

  Write-Host "Starting Mailbin frontend at http://$lanIp`:5174 ..." -ForegroundColor Cyan
  # Open Android Studio with the project
  npx cap open android

  npx vite --host 0.0.0.0 --port 5174 --strictPort
} finally {
  Pop-Location  # restore original directory even on Ctrl+C
  # Restore capacitor.config.ts to its checked-in state so the working
  # copy stays clean. Runs even if vite/cap open were killed via Ctrl+C.
  if ($originalConfig) {
    Set-Content $configPath $originalConfig -Encoding utf8 -NoNewline
    Write-Host "Reverted capacitor.config.ts to committed state" -ForegroundColor Cyan
  }
}
