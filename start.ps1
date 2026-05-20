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

# Inject IP into capacitor.config.ts for live reload on emulator/device
$configPath = "$PSScriptRoot/frontend/capacitor.config.ts"
$config = Get-Content $configPath -Raw
$updated = $config -replace "server:\s*\{[^}]*\}", "server: { androidScheme: 'https', url: 'http://$lanIp`:5174', cleartext: true }"
Set-Content $configPath $updated -Encoding utf8

Write-Host "Injected server.url http://$lanIp`:5174 into capacitor.config.ts" -ForegroundColor Cyan

# Generate app icons from resources/ into Android mipmap folders
Write-Host "Generating app icons from resources/..." -ForegroundColor Cyan
Set-Location -LiteralPath "$PSScriptRoot/frontend"
npx @capacitor/assets generate --android --assetPath ./resources

# Inject beige splash background for Android 12+ (values-v31 overrides system splash color)
$splashValuesDir = "$PSScriptRoot/frontend/android/app/src/main/res/values-v31"
New-Item -ItemType Directory -Force $splashValuesDir | Out-Null
Set-Content "$splashValuesDir/styles.xml" -Encoding utf8 @'
<?xml version="1.0" encoding="utf-8"?>
<resources>
    <style name="AppTheme.NoActionBarLaunch" parent="Theme.SplashScreen">
        <item name="android:windowSplashScreenBackground">#f5f0e8</item>
        <item name="android:windowSplashScreenAnimatedIcon">@mipmap/ic_launcher_foreground</item>
        <item name="postSplashScreenTheme">@style/AppTheme.NoActionBar</item>
    </style>
</resources>
'@
Write-Host "Injected beige splash screen (values-v31)" -ForegroundColor Cyan

# Sync web assets + updated config into the Android project
Write-Host "Syncing Capacitor Android..." -ForegroundColor Cyan
npx cap sync android

Write-Host "Starting Mailbin frontend at http://$lanIp`:5174 ..." -ForegroundColor Cyan
# Open Android Studio with the project
npx cap open android

npx vite --host 0.0.0.0 --port 5174 --strictPort
