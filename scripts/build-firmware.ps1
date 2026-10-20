param([string]$SdkPath, [string]$BuildDirectory = 'build-short', [switch]$Production, [int]$HardwareRevision = 0, [string]$SecureBootSigningKey, [switch]$ConfigureOnly)
$ErrorActionPreference = 'Stop'
if ($BuildDirectory -notmatch '^build-[a-zA-Z0-9_-]+$') { throw 'BuildDirectory must be a local build-* directory' }
$wgRoot = Split-Path -Parent $PSScriptRoot
if ($Production) {
    if ($HardwareRevision -lt 300) { throw 'Production security requires a physically verified ESP32 revision 3.0+ (HardwareRevision 300 or higher)' }
    if (-not $SecureBootSigningKey) { throw 'Provide the retained production RSA-3072 SecureBootSigningKey' }
    $wgSigningPath = (Resolve-Path -LiteralPath $SecureBootSigningKey).Path.Replace('\','/')
    if ($wgSigningPath -match '[\r\n"]') { throw 'Unsupported signing-key path' }
    $env:WG_SECURE_BOOT_CHECK_KEY = $wgSigningPath
    & node -e "const fs=require('fs'),crypto=require('crypto'); const key=crypto.createPrivateKey(fs.readFileSync(process.env.WG_SECURE_BOOT_CHECK_KEY)); if(key.asymmetricKeyType!=='rsa'||key.asymmetricKeyDetails.modulusLength!==3072)throw new Error('Secure Boot requires RSA-3072');"
    if ($LASTEXITCODE -ne 0) { throw 'Invalid Secure Boot signing key' }
    Remove-Item Env:WG_SECURE_BOOT_CHECK_KEY
    [System.IO.File]::WriteAllText((Join-Path $wgRoot 'firmware/sdkconfig.production-key.defaults'), ('CONFIG_SECURE_BOOT_SIGNING_KEY="' + $wgSigningPath + '"' + "`n"), [System.Text.UTF8Encoding]::new($false))
    $BuildDirectory = 'build-production'
}
if (-not $SdkPath) { $SdkPath = Join-Path $wgRoot '.tools/esp-idf' }
if (-not $env:IDF_TOOLS_PATH) { $env:IDF_TOOLS_PATH = Join-Path $wgRoot '.tools/espressif' }
$env:IDF_PATH = (Resolve-Path -LiteralPath $SdkPath).Path
$wgFileSystem = New-Object -ComObject Scripting.FileSystemObject
$wgShortSdk = $wgFileSystem.GetFolder($env:IDF_PATH).ShortPath
if ($wgShortSdk) { $env:IDF_PATH = $wgShortSdk }
$wgShortTools = $wgFileSystem.GetFolder($env:IDF_TOOLS_PATH).ShortPath
if ($wgShortTools) { $env:IDF_TOOLS_PATH = $wgShortTools }
$wgProject = Join-Path $wgRoot 'firmware'
$wgShortProject = $wgFileSystem.GetFolder($wgProject).ShortPath
if ($wgShortProject) { $wgProject = $wgShortProject }
$wgOriginalPath = $env:PATH
$wgVariables = & python (Join-Path $env:IDF_PATH 'tools/idf_tools.py') export --format=key-value
if ($LASTEXITCODE -ne 0) { throw 'ESP-IDF tools export failed' }
foreach ($wgLine in $wgVariables) {
    $wgPair = $wgLine -split '=', 2
    if ($wgPair.Length -eq 2) { [Environment]::SetEnvironmentVariable($wgPair[0], $wgPair[1].Replace('%PATH%', $wgOriginalPath), 'Process') }
}
$wgBuildArgs = @('-C', $wgProject, '-B', (Join-Path $wgProject $BuildDirectory))
if ($Production) { $wgBuildArgs += @('-D', ('SDKCONFIG=' + (Join-Path $wgProject 'sdkconfig.production')), '-D', 'SDKCONFIG_DEFAULTS=sdkconfig.defaults;sdkconfig.production.defaults;sdkconfig.production-key.defaults') }
if ($ConfigureOnly) { $wgBuildAction = 'reconfigure' } else { $wgBuildAction = 'build' }
& (Join-Path $env:IDF_PYTHON_ENV_PATH 'Scripts/python.exe') (Join-Path $env:IDF_PATH 'tools/idf.py') @wgBuildArgs $wgBuildAction
if ($LASTEXITCODE -ne 0) { throw 'Firmware build failed' }
