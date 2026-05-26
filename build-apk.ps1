$ErrorActionPreference = "Stop"

$rootDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$frontendDirectory = Join-Path $rootDirectory "frontend"
$androidDirectory = Join-Path $frontendDirectory "android"
$javaHome = "C:\Program Files\Android\Android Studio\jbr"
$sourceApkPath = Join-Path $androidDirectory "app\build\outputs\apk\debug\app-debug.apk"
$targetApkPath = Join-Path $rootDirectory "mailbin.apk"

if (Test-Path $javaHome) {
    $env:JAVA_HOME = $javaHome
    $env:Path = "$javaHome\bin;$env:Path"
}

Push-Location $rootDirectory
try {
    npm.cmd run build

    Push-Location $frontendDirectory
    try {
        npx.cmd cap sync android
    } finally {
        Pop-Location
    }

    Push-Location $androidDirectory
    try {
        .\gradlew.bat assembleDebug
    } finally {
        Pop-Location
    }

    Copy-Item $sourceApkPath $targetApkPath -Force
    Write-Host "Built APK: $targetApkPath"
} finally {
    Pop-Location
}
