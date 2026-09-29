[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$PhotoshopExePath,

    [string]$BridgeDllPath = (Join-Path $PSScriptRoot 'out\Release\wintab32.dll'),

    [switch]$ReplaceExisting
)

$ErrorActionPreference = 'Stop'

function Get-PeMachine([string]$Path) {
    $stream = [System.IO.File]::OpenRead($Path)
    try {
        $reader = [System.IO.BinaryReader]::new($stream)
        $stream.Position = 0x3C
        $peOffset = $reader.ReadInt32()
        if ($peOffset -lt 0 -or $peOffset -gt ($stream.Length - 6)) {
            throw "Invalid PE header: $Path"
        }
        $stream.Position = $peOffset
        if ($reader.ReadUInt32() -ne 0x00004550) {
            throw "Invalid PE signature: $Path"
        }
        return $reader.ReadUInt16()
    }
    finally {
        $stream.Dispose()
    }
}

$exe = (Resolve-Path -LiteralPath $PhotoshopExePath).Path
$dll = (Resolve-Path -LiteralPath $BridgeDllPath).Path

if ((Get-PeMachine $exe) -ne 0x8664) {
    throw 'The selected Photoshop.exe is not x64. This build cannot be loaded by 32-bit Photoshop CS6.'
}
if ((Get-PeMachine $dll) -ne 0x8664) {
    throw 'The bridge DLL is not x64. Rebuild it with the x64 Visual Studio generator.'
}

$processName = [System.IO.Path]::GetFileNameWithoutExtension($exe)
if (Get-Process -Name $processName -ErrorAction SilentlyContinue) {
    throw "Close every $processName process before installing the app-local DLL."
}

$targetDirectory = [System.IO.Path]::GetDirectoryName($exe)
$destination = Join-Path $targetDirectory 'wintab32.dll'
if (Test-Path -LiteralPath $destination) {
    if (-not $ReplaceExisting) {
        throw "A Photoshop-local wintab32.dll already exists. Inspect it first; rerun with -ReplaceExisting only if you want an in-folder backup and replacement."
    }
    $timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $backup = "$destination.backup-$timestamp"
    Copy-Item -LiteralPath $destination -Destination $backup
    Write-Host "Existing DLL backed up inside the Photoshop folder: $backup"
}

Copy-Item -LiteralPath $dll -Destination $destination -Force

# Copy the optional local config only when one is not already present.
$sourceConfig = Join-Path $PSScriptRoot 'wintab-pointer-bridge.ini'
$destinationConfig = Join-Path $targetDirectory 'wintab-pointer-bridge.ini'
if ((Test-Path -LiteralPath $sourceConfig) -and -not (Test-Path -LiteralPath $destinationConfig)) {
    Copy-Item -LiteralPath $sourceConfig -Destination $destinationConfig
}

Write-Host "Installed only in the selected Photoshop folder: $destination"
Write-Host 'No registry, Windows directory, driver, or other application files were changed.'
Write-Host 'To roll back, close Photoshop and remove this DLL; restore any .backup-* file if one was created.'
