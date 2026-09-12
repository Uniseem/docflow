#requires -Version 5.1
<#
.SYNOPSIS
  Builds the bundled Python + BabelDOC runtime used by "PDF 原生翻译" on Windows.

.DESCRIPTION
  Produces <Output>\python (relocatable CPython with the pinned BabelDOC stack)
  and <Output>\pdf-assets (verified offline models, fonts, CMaps, tokenizer).
  Point the engine at <Output> with --resources, or DOCFLOW_RESOURCES for dev.

  The Visual C++ runtime (msvcp140*.dll, vcruntime140*.dll, vcomp140.dll ...)
  is copied next to python.exe from the local Visual Studio installation:
  onnxruntime needs it and a clean Windows does not have it. The build then
  checks that every bundled module's DLL imports resolve.

.EXAMPLE
  ./runtime/build-windows.ps1
#>
param(
    [string]$Output = (Join-Path $PSScriptRoot "build\windows-x64\resources"),
    [string]$Cache = (Join-Path $PSScriptRoot "cache"),
    # Folder that contains x64\Microsoft.VC*.CRT; found with vswhere if omitted.
    [string]$VCRedist = $env:VCToolsRedistDir,
    [switch]$SkipTests,
    [switch]$SkipAssets
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

# Windows PowerShell 5.1 turns any stderr output of a native program into a
# terminating error under "Stop"; judge native steps by their exit code only.
function Invoke-Native([string]$What, [scriptblock]$Command) {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        & $Command 2>&1 | ForEach-Object { "$_" }
    } finally {
        $ErrorActionPreference = $previous
    }
    if ($LASTEXITCODE -ne 0) { throw "$What failed (exit code $LASTEXITCODE)" }
}

$PythonVersion = "3.12.14"
$Release = "20260901"
$Archive = "cpython-$PythonVersion+$Release-x86_64-pc-windows-msvc-install_only_stripped.tar.gz"
$Sha256 = "7c45c9622400d578709a9b2cddbe8124cc21d382409d9f13406d706d28e31b14"
$Url = "https://github.com/astral-sh/python-build-standalone/releases/download/$Release/" + [uri]::EscapeDataString($Archive)

$Repo = Split-Path $PSScriptRoot -Parent
$NativePdf = Join-Path $Repo "engine\native-pdf"
New-Item -ItemType Directory -Force $Output, $Cache | Out-Null
$Output = (Resolve-Path $Output).Path
if ($Output -notmatch '^[\x20-\x7E]+$') {
    throw "Output path must be ASCII (BabelDOC requirement): $Output"
}

$download = Join-Path $Cache $Archive
if (-not (Test-Path $download) -or (Get-FileHash $download -Algorithm SHA256).Hash -ne $Sha256.ToUpper()) {
    Write-Host "Downloading $Archive"
    Invoke-WebRequest -Uri $Url -OutFile "$download.partial" -UseBasicParsing
    Move-Item -Force "$download.partial" $download
}
$actual = (Get-FileHash $download -Algorithm SHA256).Hash
if ($actual -ne $Sha256.ToUpper()) {
    throw "Checksum mismatch for $Archive`: $actual"
}

$pythonRoot = Join-Path $Output "python"
if (Test-Path $pythonRoot) { Remove-Item -Recurse -Force $pythonRoot }
Write-Host "Extracting CPython $PythonVersion"
Invoke-Native "tar" { & "$env:SystemRoot\System32\tar.exe" -xzf $download -C $Output }
$python = Join-Path $pythonRoot "python.exe"

$env:PIP_CACHE_DIR = Join-Path $Cache "pip"
$env:PIP_DISABLE_PIP_VERSION_CHECK = "1"
$env:PYTHONNOUSERSITE = "1"
Write-Host "Installing pinned BabelDOC dependencies"
Invoke-Native "pip install" { & $python -m pip install --no-warn-script-location -r (Join-Path $NativePdf "requirements.txt") }
Invoke-Native "pip check" { & $python -m pip check }

Write-Host "Bundling the Visual C++ runtime"
& (Join-Path $PSScriptRoot "bundle-vc-runtime.ps1") -PythonRoot $pythonRoot -VCRedist $VCRedist

if (-not $SkipTests) {
    Write-Host "Running native adapter tests"
    Push-Location $NativePdf
    try {
        Invoke-Native "native adapter tests" { & $python -B -m unittest discover -s tests -v }
    } finally { Pop-Location }
}

# BabelDOC verifies every asset's SHA3-256 and downloads only the files it
# does not already have, so an attempt after a pause continues where the last
# one stopped. Its own retries are three tries seconds apart, which the CDN's
# rate limiting (HTTP 429 on a busy day) outlasts; these wait minutes.
if (-not $SkipAssets) {
    $assets = Join-Path $Output "pdf-assets"
    Write-Host "Preparing BabelDOC offline assets (models, fonts, CMaps, tokenizer)"
    $attempts = if ($env:DOCFLOW_ASSET_ATTEMPTS) { [int]$env:DOCFLOW_ASSET_ATTEMPTS } else { 3 }
    $attempt = 1
    while ($true) {
        try {
            Invoke-Native "asset preparation" { & $python -B (Join-Path $NativePdf "prepare_assets.py") --asset-dir $assets }
            break
        } catch {
            if ($attempt -ge $attempts) { throw }
            $delay = $attempt * 60
            Write-Host ("{0}; attempt {1}/{2} in {3}s" -f $_.Exception.Message, ($attempt + 1), $attempts, $delay)
            Start-Sleep -Seconds $delay
            $attempt++
        }
    }
    Invoke-Native "asset verification" { & $python -B (Join-Path $NativePdf "prepare_assets.py") --asset-dir $assets --verify-only }
}

Get-ChildItem $pythonRoot -Recurse -Directory -Filter "__pycache__" | Remove-Item -Recurse -Force
$vcVersion = (Get-Item (Join-Path $pythonRoot "msvcp140.dll")).VersionInfo.ProductVersion
Set-Content -Encoding ascii (Join-Path $Output "RUNTIME.txt") "CPython $PythonVersion ($Release); BabelDOC 0.6.4; Visual C++ runtime $vcVersion; windows-x64"
$size = (Get-ChildItem $Output -Recurse -File | Measure-Object Length -Sum).Sum / 1MB
Write-Host ("Runtime ready: {0} ({1:N0} MB)" -f $Output, $size)
