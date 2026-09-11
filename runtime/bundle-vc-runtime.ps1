#requires -Version 5.1
<#
.SYNOPSIS
  Copies the Visual C++ runtime next to the bundled python.exe and checks
  that every module of the runtime can load on a clean Windows PC.

.DESCRIPTION
  onnxruntime (BabelDOC's layout model) and other wheels import msvcp140.dll,
  msvcp140_1.dll or vcomp140.dll, which a clean Windows does not have. One
  consistent, current copy of the redistributable DLLs is placed next to
  python.exe (replacing the older vcruntime140 shipped with CPython; newer
  runtimes run older binaries). The files come from the local Visual Studio
  or Build Tools installation and may be redistributed with applications.

.EXAMPLE
  ./runtime/bundle-vc-runtime.ps1 -PythonRoot runtime/build/windows-x64/resources/python
#>
param(
    [Parameter(Mandatory = $true)][string]$PythonRoot,
    # Folder that contains x64\Microsoft.VC*.CRT; found with vswhere if omitted.
    [string]$VCRedist = $env:VCToolsRedistDir
)

$ErrorActionPreference = "Stop"

function Find-VCRuntime([string]$Root) {
    $roots = @()
    if ($Root) {
        $roots = @($Root)
    } else {
        $vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
        if (-not (Test-Path $vswhere)) {
            throw "vswhere.exe not found. Install Visual Studio or the Build Tools with the C++ workload, or pass -VCRedist."
        }
        $vs = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
        if ($vs) {
            $roots = Get-ChildItem (Join-Path $vs "VC\Redist\MSVC") -Directory -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -match '^\d+\.\d+\.\d+$' } |
                Sort-Object { [version]$_.Name } -Descending |
                ForEach-Object FullName
        }
    }
    foreach ($candidate in $roots) {
        $crt = Get-ChildItem (Join-Path $candidate "x64") -Directory -Filter "Microsoft.VC*.CRT" -ErrorAction SilentlyContinue | Select-Object -First 1
        $openmp = Get-ChildItem (Join-Path $candidate "x64") -Directory -Filter "Microsoft.VC*.OpenMP" -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($crt -and $openmp) { return @($crt.FullName, $openmp.FullName) }
    }
    throw "Visual C++ redistributable files (x64\Microsoft.VC*.CRT) not found; pass -VCRedist."
}

$PythonRoot = (Resolve-Path $PythonRoot).Path
$python = Join-Path $PythonRoot "python.exe"
if (-not (Test-Path $python)) { throw "python.exe not found in $PythonRoot" }

$crt, $openmp = Find-VCRuntime $VCRedist
Get-ChildItem $crt -Filter *.dll | Where-Object { $_.Name -notlike "vccorlib*" } | Copy-Item -Destination $PythonRoot -Force
Copy-Item (Join-Path $openmp "vcomp140.dll") $PythonRoot -Force
$version = (Get-Item (Join-Path $PythonRoot "msvcp140.dll")).VersionInfo.ProductVersion
Write-Host "Visual C++ runtime $version bundled from $crt"

$previous = $ErrorActionPreference
$ErrorActionPreference = "Continue"
try {
    & $python -B (Join-Path $PSScriptRoot "check-windows-dlls.py") $PythonRoot 2>&1 | ForEach-Object { "$_" }
} finally {
    $ErrorActionPreference = $previous
}
if ($LASTEXITCODE -ne 0) { throw "Some bundled modules would not load on a clean PC (see above)." }
