<#
.SYNOPSIS
    Publishes GreenMD to a stable per-user location and optionally registers it
    as a markdown handler.

.DESCRIPTION
    File association records an absolute path to the executable. Registering against
    bin\Debug works but breaks the moment the folder is cleaned or the repo moves, so
    the real install goes to %LOCALAPPDATA%\Programs\GreenMD.

    Framework-dependent by default (a few MB, needs the .NET Desktop Runtime, which is
    already present wherever the SDK is). Use -SelfContained for a machine that has no
    .NET runtime -- that produces a much larger output but needs nothing preinstalled.

.EXAMPLE
    .\Publish.ps1 -Register
    Publishes and registers the association in one step.

.EXAMPLE
    .\Publish.ps1 -SelfContained
    Builds a standalone copy to hand to a machine without .NET installed.
#>
[CmdletBinding()]
param(
    [string] $Destination = (Join-Path $env:LOCALAPPDATA 'Programs\GreenMD'),
    [switch] $SelfContained,
    [switch] $Register
)

$ErrorActionPreference = 'Stop'

$project = Join-Path $PSScriptRoot '..\GreenMD\GreenMD.csproj'
if (-not (Test-Path $project)) { throw "Project not found at $project" }

# A running copy holds a lock on its own exe and the publish will fail on the copy step.
$running = Get-Process GreenMD -ErrorAction SilentlyContinue
if ($running) {
    Write-Host "Closing running GreenMD (pid $($running.Id -join ', '))..."
    $running | Stop-Process -Force
    Start-Sleep -Milliseconds 600
}

$publishArgs = @(
    'publish', $project,
    '-c', 'Release',
    '-r', 'win-x64',
    '-o', $Destination,
    "-p:SelfContained=$($SelfContained.IsPresent.ToString().ToLower())",
    '-p:PublishSingleFile=false',
    '--nologo'
)

Write-Host "Publishing to $Destination ..."
& dotnet @publishArgs | Where-Object { $_ -match 'error|warning MSB|Determining|->' }
if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed with exit code $LASTEXITCODE" }

$exe = Join-Path $Destination 'GreenMD.exe'
if (-not (Test-Path $exe)) { throw "Publish finished but $exe is missing" }

$size = (Get-ChildItem $Destination -Recurse -File | Measure-Object -Sum Length).Sum
"Published: $exe ({0:N1} MB total)" -f ($size / 1MB)

if ($Register) {
    Write-Host 'Registering file association...'
    & $exe --register
    Start-Sleep -Milliseconds 800
    "Registered. Windows will still ask you to confirm the default the first time you open a .md file."
}
else {
    ""
    "To register the association:"
    "  & '$exe' --register"
}
