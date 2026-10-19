param([string]$SdkPath)
$ErrorActionPreference = 'Stop'
$wgRoot = Split-Path -Parent $PSScriptRoot
if (-not $SdkPath) { $SdkPath = Join-Path $wgRoot '.tools/esp-idf' }
if (-not $env:IDF_TOOLS_PATH) { $env:IDF_TOOLS_PATH = Join-Path $wgRoot '.tools/espressif' }
$env:IDF_PATH = (Resolve-Path -LiteralPath $SdkPath).Path
$wgFileSystem = New-Object -ComObject Scripting.FileSystemObject
$env:IDF_PATH = $wgFileSystem.GetFolder($env:IDF_PATH).ShortPath
$env:IDF_TOOLS_PATH = $wgFileSystem.GetFolder($env:IDF_TOOLS_PATH).ShortPath
$wgProject = $wgFileSystem.GetFolder((Join-Path $wgRoot 'firmware')).ShortPath
$wgOriginalPath = $env:PATH
$wgVariables = & python (Join-Path $env:IDF_PATH 'tools/idf_tools.py') export --format=key-value
if ($LASTEXITCODE -ne 0) { throw 'ESP-IDF tools export failed' }
foreach ($wgLine in $wgVariables) {
    $wgPair = $wgLine -split '=', 2
    if ($wgPair.Length -eq 2) { [Environment]::SetEnvironmentVariable($wgPair[0], $wgPair[1].Replace('%PATH%', $wgOriginalPath), 'Process') }
}
& (Join-Path $env:IDF_PYTHON_ENV_PATH 'Scripts/python.exe') (Join-Path $env:IDF_PATH 'tools/idf.py') -C $wgProject -B (Join-Path $wgProject 'build-short') build
if ($LASTEXITCODE -ne 0) { throw 'Firmware build failed' }
