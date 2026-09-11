#requires -Version 5.1
<#
.SYNOPSIS
  Builds the Windows app into apps\windows\dist\DocFlow, and optionally its
  setup program (-Installer) or a zip (-Zip).

.DESCRIPTION
  1. docflow-engine (Rust, release, static C runtime)
  2. the bundled Python + BabelDOC runtime (runtime\build-windows.ps1), unless
     present; the Visual C++ runtime is (re)bundled next to python.exe
  3. the WinUI 3 app, published self-contained for win-x64
  4. layout:  DocFlow.exe
              engine\docflow-engine.exe
              engine\resources\python\...      (CPython + BabelDOC)
              engine\resources\pdf-assets\...  (models, fonts, CMaps)
  5. a check that every .exe/.dll/.pyd can load on a clean Windows PC
  6. optional Authenticode signing of every unsigned binary (a signed build
     avoids the SmartScreen warning once the certificate has reputation, and
     is required where Smart App Control is on):
       -SignThumbprint <SHA-1 of a certificate in the user's store>, or
       -SignPfx <file.pfx> with the password in DOCFLOW_SIGN_PASSWORD
     (or DOCFLOW_SIGN_THUMBPRINT / DOCFLOW_SIGN_PFX), timestamped by
     -TimestampUrl (default http://timestamp.digicert.com).
  7. -Installer: dist\DocFlow-win-x64-setup.exe (installer\DocFlow.iss, a
     per-user setup program), signed like the app when signing is set up.

  Requirements: Rust (MSVC toolchain), .NET 10 SDK, Visual Studio or Build
  Tools with the C++ workload, and for -Installer Inno Setup 6.6 or later.
  The .NET SDK is taken from PATH, or from .dev\dotnet in the repository if
  present; Inno Setup from PATH, its installation, or .dev\innosetup.

.EXAMPLE
  ./apps/windows/build.ps1 -Installer
.EXAMPLE
  $env:DOCFLOW_SIGN_PASSWORD = "..."; ./apps/windows/build.ps1 -Installer -SignPfx C:\keys\docflow.pfx
#>
param(
    [switch]$Installer,
    [switch]$Zip,
    [switch]$SkipRuntime,
    [string]$SignThumbprint = $env:DOCFLOW_SIGN_THUMBPRINT,
    [string]$SignPfx = $env:DOCFLOW_SIGN_PFX,
    [string]$TimestampUrl = $(if ($env:DOCFLOW_SIGN_TIMESTAMP) { $env:DOCFLOW_SIGN_TIMESTAMP } else { "http://timestamp.digicert.com" })
)

$ErrorActionPreference = "Stop"
$Repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$Dist = Join-Path $PSScriptRoot "dist"
$App = Join-Path $Dist "DocFlow"
$Runtime = Join-Path $Repo "runtime\build\windows-x64\resources"

function Invoke-Native([string]$What, [scriptblock]$Command) {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try { & $Command 2>&1 | ForEach-Object { "$_" } } finally { $ErrorActionPreference = $previous }
    if ($LASTEXITCODE -ne 0) { throw "$What failed (exit code $LASTEXITCODE)" }
}

function Find-SignTool {
    $onPath = Get-Command signtool.exe -ErrorAction SilentlyContinue
    if ($onPath) { return $onPath.Source }
    $roots = @()
    $installed = Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows Kits\Installed Roots" -ErrorAction SilentlyContinue
    if ($installed -and $installed.KitsRoot10) { $roots += $installed.KitsRoot10 }
    $roots += Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10"
    foreach ($root in $roots) {
        $tool = Get-ChildItem (Join-Path $root "bin\*\x64\signtool.exe") -ErrorAction SilentlyContinue |
            Sort-Object { [version]$_.Directory.Parent.Name } -Descending | Select-Object -First 1
        if ($tool) { return $tool.FullName }
    }
    throw "signtool.exe not found; install the Windows SDK."
}

function Find-InnoCompiler {
    $onPath = Get-Command ISCC.exe -ErrorAction SilentlyContinue
    if ($onPath) { return $onPath.Source }
    $places = @(Join-Path $Repo ".dev\innosetup")
    foreach ($key in @(
        "HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Inno Setup 6_is1",
        "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Inno Setup 6_is1",
        "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Inno Setup 6_is1")) {
        $location = (Get-ItemProperty $key -ErrorAction SilentlyContinue).InstallLocation
        if ($location) { $places += $location }
    }
    $places += @(
        (Join-Path ${env:ProgramFiles(x86)} "Inno Setup 6"),
        (Join-Path $env:ProgramFiles "Inno Setup 6"),
        (Join-Path $env:LOCALAPPDATA "Programs\Inno Setup 6"))
    foreach ($place in $places) {
        $compiler = Join-Path $place "ISCC.exe"
        if (Test-Path $compiler) { return $compiler }
    }
    throw "ISCC.exe not found; install Inno Setup 6.6 or later (https://jrsoftware.org/isdl.php)."
}

$localDotnet = Join-Path $Repo ".dev\dotnet"
if (Test-Path (Join-Path $localDotnet "dotnet.exe")) {
    $env:DOTNET_ROOT = $localDotnet
    $env:PATH = "$localDotnet;$env:PATH"
}
$env:DOTNET_CLI_TELEMETRY_OPTOUT = "1"
$env:DOTNET_NOLOGO = "1"

Write-Host "==> Engine (release)"
# Run from the repository so .cargo\config.toml (static C runtime) applies.
Push-Location $Repo
try {
    Invoke-Native "cargo build" { cargo build --release --locked --manifest-path (Join-Path $Repo "engine\Cargo.toml") }
} finally { Pop-Location }

if (-not $SkipRuntime -and -not (Test-Path (Join-Path $Runtime "pdf-assets\.ready"))) {
    Write-Host "==> Python + BabelDOC runtime"
    & (Join-Path $Repo "runtime\build-windows.ps1")
} elseif (Test-Path (Join-Path $Runtime "python\python.exe")) {
    Write-Host "==> Visual C++ runtime for the bundled Python"
    & (Join-Path $Repo "runtime\bundle-vc-runtime.ps1") -PythonRoot (Join-Path $Runtime "python")
}

Write-Host "==> WinUI app"
if (Test-Path $App) { Remove-Item -Recurse -Force $App }
Invoke-Native "dotnet publish" {
    dotnet publish (Join-Path $PSScriptRoot "DocFlow\DocFlow.csproj") -c Release -r win-x64 -p:Platform=x64 --self-contained -o $App
}

Write-Host "==> Layout"
$engineDir = Join-Path $App "engine"
New-Item -ItemType Directory -Force $engineDir | Out-Null
Copy-Item (Join-Path $Repo "engine\target\release\docflow-engine.exe") $engineDir
$bundledPython = Join-Path $engineDir "resources\python\python.exe"
if (Test-Path $Runtime) {
    # robocopy exit codes below 8 mean success.
    robocopy $Runtime (Join-Path $engineDir "resources") /E /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy failed ($LASTEXITCODE)" }
    $global:LASTEXITCODE = 0
} else {
    Write-Warning "Runtime not found at $Runtime; PDF 原生翻译 will be unavailable in this build."
}
Copy-Item (Join-Path $Repo "LICENSE"), (Join-Path $Repo "THIRD_PARTY_NOTICES.md") $App

Write-Host "==> Clean-PC DLL check"
$checker = Join-Path $Repo "runtime\check-windows-dlls.py"
$checkPython = if (Test-Path $bundledPython) { $bundledPython } else { (Get-Command python -ErrorAction Stop).Source }
Invoke-Native "DLL import check" { & $checkPython -B $checker $App }

$signArgs = $null
if ($SignThumbprint -or $SignPfx) {
    Write-Host "==> Authenticode signing"
    $signtool = Find-SignTool
    $unsigned = Get-ChildItem $App -Recurse -File -Include *.exe, *.dll, *.pyd |
        Where-Object { (Get-AuthenticodeSignature $_.FullName).Status -eq "NotSigned" }
    $signArgs = @("sign", "/fd", "sha256", "/tr", $TimestampUrl, "/td", "sha256")
    if ($SignPfx) {
        $signArgs += @("/f", $SignPfx)
        if ($env:DOCFLOW_SIGN_PASSWORD) { $signArgs += @("/p", $env:DOCFLOW_SIGN_PASSWORD) }
    } else {
        $signArgs += @("/sha1", $SignThumbprint)
    }
    Write-Host ("Signing {0} files" -f $unsigned.Count)
    for ($index = 0; $index -lt $unsigned.Count; $index += 40) {
        $batch = @($unsigned[$index..([Math]::Min($index + 39, $unsigned.Count - 1))] | ForEach-Object FullName)
        Invoke-Native "signtool sign" { & $signtool @signArgs @batch }
    }
    Invoke-Native "signtool verify" { & $signtool verify /pa /q (Join-Path $App "DocFlow.exe") (Join-Path $engineDir "docflow-engine.exe") }
}

if ($Installer) {
    $setup = Join-Path $Dist "DocFlow-win-x64-setup.exe"
    if (Test-Path $setup) { Remove-Item -Force $setup }
    Write-Host "==> $setup"
    $project = Get-Content (Join-Path $PSScriptRoot "DocFlow\DocFlow.csproj") -Raw
    if ($project -notmatch "<Version>([^<]+)</Version>") { throw "no <Version> in DocFlow.csproj" }
    $version = $Matches[1]
    $compiler = Find-InnoCompiler
    Invoke-Native "Inno Setup" {
        & $compiler /Qp "/DAppVersion=$version" "/DAppDir=$App" "/DOutputDir=$Dist" (Join-Path $PSScriptRoot "installer\DocFlow.iss")
    }
    if ($signArgs) {
        Invoke-Native "signtool sign" { & $signtool @signArgs $setup }
        Invoke-Native "signtool verify" { & $signtool verify /pa /q $setup }
    }
    Write-Host ("Setup: {0:N0} MB" -f ((Get-Item $setup).Length / 1MB))
}

if ($Zip) {
    $archive = Join-Path $Dist "DocFlow-win-x64.zip"
    if (Test-Path $archive) { Remove-Item -Force $archive }
    Write-Host "==> $archive"
    Compress-Archive -Path $App -DestinationPath $archive -CompressionLevel Optimal
}

$size = (Get-ChildItem $App -Recurse -File | Measure-Object Length -Sum).Sum / 1MB
Write-Host ("Done: {0} ({1:N0} MB)" -f $App, $size)
