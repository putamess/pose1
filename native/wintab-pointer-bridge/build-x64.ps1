$ErrorActionPreference = 'Stop'

$projectRoot = $PSScriptRoot
$buildDir = Join-Path $projectRoot 'out'

$cmake = Get-Command cmake -ErrorAction SilentlyContinue
if (-not $cmake) {
    throw 'CMake 3.21+ was not found. Install CMake and the Visual Studio C++ x64 tools first.'
}

# Use the VS 2022 x64 generator. Change the generator name here if your installed VS is older.
& $cmake.Source -S $projectRoot -B $buildDir -G 'Visual Studio 17 2022' -A x64
if ($LASTEXITCODE -ne 0) {
    throw "CMake configure failed with exit code $LASTEXITCODE."
}

& $cmake.Source --build $buildDir --config Release
if ($LASTEXITCODE -ne 0) {
    throw "DLL build failed with exit code $LASTEXITCODE."
}

$dll = Join-Path $buildDir 'Release\wintab32.dll'
if (-not (Test-Path -LiteralPath $dll)) {
    throw "Build completed but the expected DLL was not found: $dll"
}
Write-Host "Built x64 DLL: $dll"
